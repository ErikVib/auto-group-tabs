// Auto Group Tabs - Firefox background script
//
// Main changes compared with the original implementation:
// 1. groupId values are NOT persisted.
// 2. Groups are resolved dynamically by windowId + title.
// 3. Grouping is isolated per Firefox window.
// 4. Operations for the same window are serialized to avoid races.
// 5. Tabs already in the correct group are not grouped again.
// 6. "etc" groups are created separately for each window.
// 7. Wildcard matching treats "*" as a wildcard and escapes other regex chars.
// 8. Legacy groupMap storage is automatically removed.

const UNGROUPED_ID = -1;
const UNMATCHED_GROUP_NAME = "etc";
const UNMATCHED_GROUP_COLOR = "grey";

const VALID_COLORS = new Set([
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange"
]);

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function normalizeColor(color, fallback = "blue") {
  const normalized =
    color === "gray"
      ? "grey"
      : color;

  return VALID_COLORS.has(normalized)
    ? normalized
    : fallback;
}

function wildcardMatch(url, pattern) {
  if (!url || !pattern) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);

    const hostname = parsedUrl.hostname.replace(/^www\./i, "");

    const target =
      `${hostname}${parsedUrl.pathname}${parsedUrl.search}`;

    const normalizedPattern = String(pattern)
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "");

    if (!normalizedPattern) {
      return false;
    }

    // Escape every regex-special character except "*".
    // "*" remains the only wildcard supported by the extension.
    const regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    const regex = new RegExp(regexPattern, "i");

    return regex.test(hostname) || regex.test(target);
  } catch (error) {
    console.warn("wildcardMatch failed:", {
      url,
      pattern,
      error
    });

    return false;
  }
}

async function getSettings() {
  const {
    groups = [],
    groupUnmatched = true
  } = await browser.storage.local.get([
    "groups",
    "groupUnmatched"
  ]);

  return {
    groups: Array.isArray(groups) ? groups : [],
    groupUnmatched
  };
}

function findMatchingRule(url, groups) {
  if (!url) {
    return null;
  }

  for (const group of groups) {
    if (!group?.name || !group?.pattern) {
      continue;
    }

    if (wildcardMatch(url, group.pattern)) {
      return group;
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Per-window operation queue
// -----------------------------------------------------------------------------
//
// tabs.onUpdated can fire several times in quick succession.
//
// Without serialization, two handlers can both:
//   - see that a group doesn't exist
//   - create it
//
// producing duplicate groups or conflicting tab moves.
//
// Operations are serialized only within the same Firefox window.
// Different windows can still be processed independently.

const windowQueues = new Map();

function enqueueWindowOperation(windowId, operation) {
  const previous =
    windowQueues.get(windowId) || Promise.resolve();

  const next = previous
    .catch(() => {
      // Prevent one failed operation from permanently breaking the queue.
    })
    .then(operation)
    .finally(() => {
      if (windowQueues.get(windowId) === next) {
        windowQueues.delete(windowId);
      }
    });

  windowQueues.set(windowId, next);

  return next;
}

// -----------------------------------------------------------------------------
// Group lookup
// -----------------------------------------------------------------------------

async function findGroups(windowId, title) {
  try {
    return await browser.tabGroups.query({
      windowId,
      title
    });
  } catch (error) {
    console.error(
      `Could not query group "${title}" in window ${windowId}:`,
      error
    );

    return [];
  }
}

async function findGroup(windowId, title) {
  const groups = await findGroups(windowId, title);

  return groups.length > 0
    ? groups[0]
    : null;
}

async function updateGroupAppearance(group, title, color) {
  const normalizedColor = normalizeColor(color);

  const needsUpdate =
    group.title !== title ||
    group.color !== normalizedColor;

  if (!needsUpdate) {
    return group;
  }

  try {
    return await browser.tabGroups.update(group.id, {
      title,
      color: normalizedColor
    });
  } catch (error) {
    console.warn(
      `Could not update group "${title}" (${group.id}):`,
      error
    );

    return group;
  }
}

// -----------------------------------------------------------------------------
// Group tabs
// -----------------------------------------------------------------------------

async function ensureTabsInGroup(
  windowId,
  groupName,
  color,
  tabs
) {
  if (!tabs || tabs.length === 0) {
    return null;
  }

  // Defensive check: never mix tabs from multiple Firefox windows.
  const windowTabs = tabs.filter(
    tab =>
      tab?.id != null &&
      tab.windowId === windowId
  );

  if (windowTabs.length === 0) {
    return null;
  }

  let group = await findGroup(windowId, groupName);

  if (!group) {
    try {
      const groupId = await browser.tabs.group({
        tabIds: windowTabs.map(tab => tab.id),
        createProperties: {
          windowId
        }
      });

      group = await browser.tabGroups.get(groupId);

      console.debug(
        `Created group "${groupName}" in window ${windowId}`,
        groupId
      );
    } catch (error) {
      console.error(
        `Could not create group "${groupName}" in window ${windowId}:`,
        error
      );

      return null;
    }
  } else {
    // Avoid unnecessary tabs.group() calls.
    //
    // tabs.group() can move tabs because tabs inside a group have to stay
    // adjacent. Calling it repeatedly on an already-correct tab is unnecessary.
    const tabsToMove = windowTabs.filter(
      tab => tab.groupId !== group.id
    );

    if (tabsToMove.length > 0) {
      try {
        await browser.tabs.group({
          groupId: group.id,
          tabIds: tabsToMove.map(tab => tab.id)
        });

        console.debug(
          `Moved ${tabsToMove.length} tab(s) into "${groupName}"`,
          group.id
        );
      } catch (error) {
        console.error(
          `Could not add tabs to group "${groupName}":`,
          error
        );

        return null;
      }
    }
  }

  return updateGroupAppearance(
    group,
    groupName,
    color
  );
}

// -----------------------------------------------------------------------------
// Process one tab
// -----------------------------------------------------------------------------

async function applyRuleToTab(tabId) {
  let tab;

  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    // Tab may have been closed before the queued operation ran.
    return;
  }

  if (!tab?.url || tab.id == null) {
    return;
  }

  const {
    groups,
    groupUnmatched
  } = await getSettings();

  const matchedGroup =
    findMatchingRule(tab.url, groups);

  if (matchedGroup) {
    await ensureTabsInGroup(
      tab.windowId,
      matchedGroup.name,
      matchedGroup.color || "blue",
      [tab]
    );

    return;
  }

  if (groupUnmatched) {
    await ensureTabsInGroup(
      tab.windowId,
      UNMATCHED_GROUP_NAME,
      UNMATCHED_GROUP_COLOR,
      [tab]
    );

    return;
  }

  if (
    tab.groupId != null &&
    tab.groupId !== UNGROUPED_ID
  ) {
    try {
      await browser.tabs.ungroup(tab.id);
    } catch (error) {
      console.warn(
        `Could not ungroup tab ${tab.id}:`,
        error
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Reconcile a complete Firefox window
// -----------------------------------------------------------------------------

async function reconcileWindow(windowId) {
  const {
    groups,
    groupUnmatched
  } = await getSettings();

  let tabs;

  try {
    tabs = await browser.tabs.query({
      windowId
    });
  } catch (error) {
    console.error(
      `Could not query tabs for window ${windowId}:`,
      error
    );

    return;
  }

  // Map:
  //
  // group name ->
  // {
  //   color,
  //   tabs[]
  // }
  //
  // First matching rule wins, preserving original behaviour.
  const targetGroups = new Map();

  const unmatchedTabs = [];

  for (const tab of tabs) {
    if (!tab.url || tab.id == null) {
      continue;
    }

    const matchedGroup =
      findMatchingRule(tab.url, groups);

    if (!matchedGroup) {
      unmatchedTabs.push(tab);
      continue;
    }

    if (!targetGroups.has(matchedGroup.name)) {
      targetGroups.set(matchedGroup.name, {
        color: matchedGroup.color || "blue",
        tabs: []
      });
    }

    targetGroups
      .get(matchedGroup.name)
      .tabs
      .push(tab);
  }

  // Process configured groups.
  for (const [groupName, target] of targetGroups) {
    await ensureTabsInGroup(
      windowId,
      groupName,
      target.color,
      target.tabs
    );
  }

  if (groupUnmatched) {
    if (unmatchedTabs.length > 0) {
      await ensureTabsInGroup(
        windowId,
        UNMATCHED_GROUP_NAME,
        UNMATCHED_GROUP_COLOR,
        unmatchedTabs
      );
    }
  } else {
    const tabsToUngroup = unmatchedTabs
      .filter(
        tab =>
          tab.groupId != null &&
          tab.groupId !== UNGROUPED_ID
      )
      .map(tab => tab.id);

    if (tabsToUngroup.length > 0) {
      try {
        await browser.tabs.ungroup(
          tabsToUngroup
        );
      } catch (error) {
        console.error(
          `Could not ungroup unmatched tabs in window ${windowId}:`,
          error
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Apply rules to every existing tab
// -----------------------------------------------------------------------------

async function applyRulesToAllTabs() {
  let tabs;

  try {
    tabs = await browser.tabs.query({});
  } catch (error) {
    console.error(
      "Could not query tabs:",
      error
    );

    return;
  }

  const windowIds = [
    ...new Set(
      tabs
        .map(tab => tab.windowId)
        .filter(windowId => windowId != null)
    )
  ];

  await Promise.all(
    windowIds.map(windowId =>
      enqueueWindowOperation(
        windowId,
        () => reconcileWindow(windowId)
      )
    )
  );
}

// -----------------------------------------------------------------------------
// Update color
// -----------------------------------------------------------------------------

async function updateGroupColor(
  groupName,
  newColor
) {
  const normalizedColor =
    normalizeColor(newColor);

  let groups;

  try {
    groups = await browser.tabGroups.query({
      title: groupName
    });
  } catch (error) {
    console.error(
      `Could not find groups named "${groupName}":`,
      error
    );

    return;
  }

  await Promise.all(
    groups.map(async group => {
      try {
        await browser.tabGroups.update(
          group.id,
          {
            color: normalizedColor
          }
        );
      } catch (error) {
        console.warn(
          `Could not update color of group ${group.id}:`,
          error
        );
      }
    })
  );
}

// -----------------------------------------------------------------------------
// Ungroup tabs that no longer match an edited pattern
// -----------------------------------------------------------------------------

async function ungroupMismatchedTabs(
  groupName,
  newPattern
) {
  let matchingGroups;

  try {
    matchingGroups =
      await browser.tabGroups.query({
        title: groupName
      });
  } catch (error) {
    console.error(
      `Could not find group "${groupName}":`,
      error
    );

    return;
  }

  await Promise.all(
    matchingGroups.map(group =>
      enqueueWindowOperation(
        group.windowId,
        async () => {
          let tabs;

          try {
            tabs = await browser.tabs.query({
              groupId: group.id
            });
          } catch (error) {
            console.warn(
              `Could not query tabs for group ${group.id}:`,
              error
            );

            return;
          }

          const tabsToUngroup = tabs
            .filter(
              tab =>
                !tab.url ||
                !wildcardMatch(
                  tab.url,
                  newPattern
                )
            )
            .map(tab => tab.id)
            .filter(id => id != null);

          if (tabsToUngroup.length === 0) {
            return;
          }

          try {
            await browser.tabs.ungroup(
              tabsToUngroup
            );
          } catch (error) {
            console.error(
              `Could not ungroup tabs from "${groupName}":`,
              error
            );
          }
        }
      )
    )
  );
}

// -----------------------------------------------------------------------------
// Runtime messages from options/popup
// -----------------------------------------------------------------------------

browser.runtime.onMessage.addListener(
  message => {
    if (
      message.action ===
      "applyRulesToAllTabs"
    ) {
      return applyRulesToAllTabs()
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    if (
      message.action ===
      "updateGroupColor"
    ) {
      return updateGroupColor(
        message.groupName,
        message.newColor
      )
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    if (
      message.action ===
      "ungroupMismatchedTabs"
    ) {
      return ungroupMismatchedTabs(
        message.groupName,
        message.newPattern
      )
        .then(() => ({
          success: true
        }))
        .catch(error => ({
          success: false,
          error: String(error)
        }));
    }

    return undefined;
  }
);

// -----------------------------------------------------------------------------
// Handle URL changes
// -----------------------------------------------------------------------------

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    // Ignore groupId/title/favicon/etc updates.
    //
    // We only need to reconsider grouping when the URL changes.
    if (!changeInfo.url) {
      return;
    }

    if (tab.windowId == null) {
      return;
    }

    enqueueWindowOperation(
      tab.windowId,
      () => applyRuleToTab(tabId)
    ).catch(error => {
      console.error(
        `Could not process updated tab ${tabId}:`,
        error
      );
    });
  }
);

// -----------------------------------------------------------------------------
// Legacy migration
// -----------------------------------------------------------------------------
//
// Old versions persisted:
//
//   groupMap[groupName] = groupId
//
// Firefox explicitly does not guarantee that a restored group keeps the same
// groupId across browser sessions.
//
// Remove the obsolete cache. Groups are now always looked up using
// windowId + title.

browser.storage.local
  .remove("groupMap")
  .catch(error => {
    console.warn(
      "Could not remove legacy groupMap:",
      error
    );
  });

console.log(
  "Auto Group Tabs background initialized"
);
