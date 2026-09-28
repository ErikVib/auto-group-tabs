// Auto Group Tabs - Firefox background script

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
// General helpers
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

function normalizeGroupName(name) {
  return String(name || "")
    .trim()
    .toLocaleLowerCase();
}

function compareGroupNames(a, b) {
  return String(a || "").localeCompare(
    String(b || ""),
    undefined,
    {
      sensitivity: "base",
      numeric: true
    }
  );
}

// -----------------------------------------------------------------------------
// Wildcard matching
// -----------------------------------------------------------------------------

function wildcardMatch(url, pattern) {
  if (!url || !pattern) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);

    const hostname = parsedUrl.hostname;

    const target =
      `${hostname}${parsedUrl.pathname}${parsedUrl.search}`;

    const targetWithoutWww =
      `${hostname.replace(/^www\./i, "")}` +
      `${parsedUrl.pathname}${parsedUrl.search}`;

    const normalizedPattern = String(pattern)
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "");

    if (!normalizedPattern) {
      return false;
    }

    // Escape regex metacharacters except "*".
    // "*" is converted to the extension's wildcard.
    const regexPattern = normalizedPattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    const regex =
      new RegExp(regexPattern, "i");

    return (
      regex.test(hostname) ||
      regex.test(target) ||
      regex.test(targetWithoutWww)
    );
  } catch (error) {
    console.warn(
      "wildcardMatch failed:",
      {
        url,
        pattern,
        error
      }
    );

    return false;
  }
}

// -----------------------------------------------------------------------------
// Rule metadata migration
// -----------------------------------------------------------------------------

function normalizeCreatedOrders(groups) {
  const result =
    groups.map(group => ({
      ...group
    }));

  const usedOrders =
    new Set();

  let maxOrder =
    result.reduce(
      (max, group) => {
        if (
          Number.isInteger(group.createdOrder) &&
          group.createdOrder > 0
        ) {
          return Math.max(
            max,
            group.createdOrder
          );
        }

        return max;
      },
      0
    );

  let nextOrder =
    maxOrder + 1;

  let changed = false;

  for (const group of result) {
    const valid =
      Number.isInteger(group.createdOrder) &&
      group.createdOrder > 0 &&
      !usedOrders.has(group.createdOrder);

    if (valid) {
      usedOrders.add(
        group.createdOrder
      );

      continue;
    }

    group.createdOrder =
      nextOrder++;

    usedOrders.add(
      group.createdOrder
    );

    changed = true;
  }

  return {
    groups: result,
    changed
  };
}

async function migrateStorage() {
  const {
    groups = [],
    groupSortMode = "alphabetical"
  } =
    await browser.storage.local.get([
      "groups",
      "groupSortMode"
    ]);

  const normalized =
    normalizeCreatedOrders(
      Array.isArray(groups)
        ? groups
        : []
    );

  const updates = {};

  if (normalized.changed) {
    updates.groups =
      normalized.groups;
  }

  if (
    groupSortMode !== "creation" &&
    groupSortMode !== "alphabetical"
  ) {
    updates.groupSortMode =
      "alphabetical";
  }

  if (
    Object.keys(updates).length > 0
  ) {
    await browser.storage.local.set(
      updates
    );
  }

  // Legacy implementation persisted Firefox group IDs.
  // They aren't stable across sessions.
  await browser.storage.local.remove(
    "groupMap"
  );
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

async function getSettings() {
  const {
    groups = [],
    groupUnmatched = true,
    groupSortMode = "alphabetical"
  } =
    await browser.storage.local.get([
      "groups",
      "groupUnmatched",
      "groupSortMode"
    ]);

  return {
    groups:
      Array.isArray(groups)
        ? groups
        : [],

    groupUnmatched,

    groupSortMode:
      groupSortMode === "creation"
        ? "creation"
        : "alphabetical"
  };
}

function findMatchingRule(
  url,
  groups
) {
  if (!url) {
    return null;
  }

  for (const group of groups) {
    if (
      !group?.name ||
      !group?.pattern
    ) {
      continue;
    }

    if (
      wildcardMatch(
        url,
        group.pattern
      )
    ) {
      return group;
    }
  }

  return null;
}

// -----------------------------------------------------------------------------
// Per-window operation queue
// -----------------------------------------------------------------------------

const windowQueues =
  new Map();

function enqueueWindowOperation(
  windowId,
  operation
) {
  const previous =
    windowQueues.get(windowId) ||
    Promise.resolve();

  const next =
    previous
      .catch(() => {
        // A failed operation should not poison the queue.
      })
      .then(operation)
      .finally(() => {
        if (
          windowQueues.get(windowId) ===
          next
        ) {
          windowQueues.delete(
            windowId
          );
        }
      });

  windowQueues.set(
    windowId,
    next
  );

  return next;
}

// -----------------------------------------------------------------------------
// Group lookup
// -----------------------------------------------------------------------------

async function findGroups(
  windowId,
  title
) {
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

async function findGroup(
  windowId,
  title
) {
  const groups =
    await findGroups(
      windowId,
      title
    );

  return groups.length > 0
    ? groups[0]
    : null;
}

async function updateGroupAppearance(
  group,
  title,
  color
) {
  const normalizedColor =
    normalizeColor(color);

  const needsUpdate =
    group.title !== title ||
    group.color !== normalizedColor;

  if (!needsUpdate) {
    return group;
  }

  try {
    return await browser.tabGroups.update(
      group.id,
      {
        title,
        color: normalizedColor
      }
    );
  } catch (error) {
    console.warn(
      `Could not update group "${title}" (${group.id}):`,
      error
    );

    return group;
  }
}

// -----------------------------------------------------------------------------
// Ensure tabs are in target group
// -----------------------------------------------------------------------------

async function ensureTabsInGroup(
  windowId,
  groupName,
  color,
  tabs
) {
  if (
    !tabs ||
    tabs.length === 0
  ) {
    return null;
  }

  const windowTabs =
    tabs.filter(
      tab =>
        tab?.id != null &&
        tab.windowId === windowId
    );

  if (
    windowTabs.length === 0
  ) {
    return null;
  }

  let group =
    await findGroup(
      windowId,
      groupName
    );

  if (!group) {
    try {
      const groupId =
        await browser.tabs.group({
          tabIds:
            windowTabs.map(
              tab => tab.id
            ),

          createProperties: {
            windowId
          }
        });

      group =
        await browser.tabGroups.get(
          groupId
        );

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
    const tabsToMove =
      windowTabs.filter(
        tab =>
          tab.groupId !== group.id
      );

    if (
      tabsToMove.length > 0
    ) {
      try {
        await browser.tabs.group({
          groupId: group.id,

          tabIds:
            tabsToMove.map(
              tab => tab.id
            )
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
// Group sorting
// -----------------------------------------------------------------------------

async function sortGroupsInWindow(
  windowId
) {
  const {
    groups: rules,
    groupUnmatched,
    groupSortMode
  } =
    await getSettings();

  let actualGroups;

  try {
    actualGroups =
      await browser.tabGroups.query({
        windowId
      });
  } catch (error) {
    console.error(
      `Could not query groups for window ${windowId}:`,
      error
    );

    return;
  }

  if (
    actualGroups.length < 2
  ) {
    return;
  }

  const ruleByName =
    new Map();

  rules.forEach(
    (rule, index) => {
      ruleByName.set(
        normalizeGroupName(
          rule.name
        ),
        {
          rule,
          index
        }
      );
    }
  );

  // Only groups managed by this extension participate.
  const managedGroups =
    actualGroups.filter(
      group => {
        if (
          ruleByName.has(
            normalizeGroupName(
              group.title
            )
          )
        ) {
          return true;
        }

        return (
          groupUnmatched &&
          normalizeGroupName(
            group.title
          ) ===
            normalizeGroupName(
              UNMATCHED_GROUP_NAME
            )
        );
      }
    );

  if (
    managedGroups.length < 2
  ) {
    return;
  }

  if (
    groupSortMode ===
    "alphabetical"
  ) {
    managedGroups.sort(
      (a, b) =>
        compareGroupNames(
          a.title,
          b.title
        )
    );
  } else {
    managedGroups.sort(
      (a, b) => {
        const aRule =
          ruleByName.get(
            normalizeGroupName(
              a.title
            )
          );

        const bRule =
          ruleByName.get(
            normalizeGroupName(
              b.title
            )
          );

        // "etc" is synthetic. Keep it after
        // explicitly-created rules in creation mode.
        const aOrder =
          normalizeGroupName(
            a.title
          ) ===
          normalizeGroupName(
            UNMATCHED_GROUP_NAME
          )
            ? Number.MAX_SAFE_INTEGER
            : (
                aRule?.rule
                  ?.createdOrder ??
                aRule?.index ??
                Number.MAX_SAFE_INTEGER
              );

        const bOrder =
          normalizeGroupName(
            b.title
          ) ===
          normalizeGroupName(
            UNMATCHED_GROUP_NAME
          )
            ? Number.MAX_SAFE_INTEGER
            : (
                bRule?.rule
                  ?.createdOrder ??
                bRule?.index ??
                Number.MAX_SAFE_INTEGER
              );

        if (
          aOrder !== bOrder
        ) {
          return aOrder - bOrder;
        }

        return compareGroupNames(
          a.title,
          b.title
        );
      }
    );
  }

  let tabs;

  try {
    tabs =
      await browser.tabs.query({
        windowId
      });
  } catch (error) {
    console.error(
      `Could not query tabs for sorting in window ${windowId}:`,
      error
    );

    return;
  }

  const managedIds =
    new Set(
      managedGroups.map(
        group => group.id
      )
    );

  const managedTabs =
    tabs.filter(
      tab =>
        managedIds.has(
          tab.groupId
        )
    );

  if (
    managedTabs.length === 0
  ) {
    return;
  }

  let targetIndex =
    Math.min(
      ...managedTabs.map(
        tab => tab.index
      )
    );

  for (
    const group of managedGroups
  ) {
    let groupTabs;

    try {
      groupTabs =
        await browser.tabs.query({
          groupId: group.id
        });
    } catch (error) {
      console.warn(
        `Could not query tabs for group ${group.id}:`,
        error
      );

      continue;
    }

    if (
      groupTabs.length === 0
    ) {
      continue;
    }

    groupTabs.sort(
      (a, b) =>
        a.index - b.index
    );

    const currentIndex =
      groupTabs[0].index;

    if (
      currentIndex !== targetIndex
    ) {
      try {
        await browser.tabGroups.move(
          group.id,
          {
            index: targetIndex
          }
        );
      } catch (error) {
        console.warn(
          `Could not move group "${group.title}":`,
          error
        );
      }
    }

    targetIndex +=
      groupTabs.length;
  }
}

async function sortAllGroups() {
  let tabs;

  try {
    tabs =
      await browser.tabs.query({});
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
        .map(
          tab => tab.windowId
        )
        .filter(
          windowId =>
            windowId != null
        )
    )
  ];

  await Promise.all(
    windowIds.map(
      windowId =>
        enqueueWindowOperation(
          windowId,
          () =>
            sortGroupsInWindow(
              windowId
            )
        )
    )
  );
}

// -----------------------------------------------------------------------------
// Process one tab
// -----------------------------------------------------------------------------

async function applyRuleToTab(
  tabId
) {
  let tab;

  try {
    tab =
      await browser.tabs.get(
        tabId
      );
  } catch {
    // Tab may have been closed before its queued task ran.
    return;
  }

  if (
    !tab?.url ||
    tab.id == null
  ) {
    return;
  }

  const {
    groups,
    groupUnmatched
  } =
    await getSettings();

  const matchedGroup =
    findMatchingRule(
      tab.url,
      groups
    );

  if (matchedGroup) {
    await ensureTabsInGroup(
      tab.windowId,
      matchedGroup.name,
      matchedGroup.color ||
        "blue",
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
    tab.groupId !==
      UNGROUPED_ID
  ) {
    try {
      await browser.tabs.ungroup(
        [tab.id]
      );
    } catch (error) {
      console.warn(
        `Could not ungroup tab ${tab.id}:`,
        error
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Reconcile a complete window
// -----------------------------------------------------------------------------

async function reconcileWindow(
  windowId
) {
  const {
    groups,
    groupUnmatched
  } =
    await getSettings();

  let tabs;

  try {
    tabs =
      await browser.tabs.query({
        windowId
      });
  } catch (error) {
    console.error(
      `Could not query tabs for window ${windowId}:`,
      error
    );

    return;
  }

  const targetGroups =
    new Map();

  const unmatchedTabs = [];

  for (const tab of tabs) {
    if (
      !tab.url ||
      tab.id == null
    ) {
      continue;
    }

    const matchedGroup =
      findMatchingRule(
        tab.url,
        groups
      );

    if (!matchedGroup) {
      unmatchedTabs.push(
        tab
      );

      continue;
    }

    if (
      !targetGroups.has(
        matchedGroup.name
      )
    ) {
      targetGroups.set(
        matchedGroup.name,
        {
          color:
            matchedGroup.color ||
            "blue",

          tabs: []
        }
      );
    }

    targetGroups
      .get(matchedGroup.name)
      .tabs
      .push(tab);
  }

  for (
    const [
      groupName,
      target
    ] of targetGroups
  ) {
    await ensureTabsInGroup(
      windowId,
      groupName,
      target.color,
      target.tabs
    );
  }

  if (groupUnmatched) {
    if (
      unmatchedTabs.length > 0
    ) {
      await ensureTabsInGroup(
        windowId,
        UNMATCHED_GROUP_NAME,
        UNMATCHED_GROUP_COLOR,
        unmatchedTabs
      );
    }
  } else {
    const tabsToUngroup =
      unmatchedTabs
        .filter(
          tab =>
            tab.groupId != null &&
            tab.groupId !==
              UNGROUPED_ID
        )
        .map(
          tab => tab.id
        );

    if (
      tabsToUngroup.length > 0
    ) {
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

  await sortGroupsInWindow(
    windowId
  );
}

// -----------------------------------------------------------------------------
// Apply rules to every existing tab
// -----------------------------------------------------------------------------

async function applyRulesToAllTabs() {
  let tabs;

  try {
    tabs =
      await browser.tabs.query({});
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
        .map(
          tab => tab.windowId
        )
        .filter(
          windowId =>
            windowId != null
        )
    )
  ];

  await Promise.all(
    windowIds.map(
      windowId =>
        enqueueWindowOperation(
          windowId,
          () =>
            reconcileWindow(
              windowId
            )
        )
    )
  );
}

// -----------------------------------------------------------------------------
// Update group color
// -----------------------------------------------------------------------------

async function updateGroupColor(
  groupName,
  newColor
) {
  let groups;

  try {
    groups =
      await browser.tabGroups.query({
        title: groupName
      });
  } catch (error) {
    console.error(
      `Could not find groups named "${groupName}":`,
      error
    );

    return;
  }

  const color =
    normalizeColor(
      newColor
    );

  await Promise.all(
    groups.map(
      async group => {
        try {
          await browser.tabGroups.update(
            group.id,
            {
              color
            }
          );
        } catch (error) {
          console.warn(
            `Could not update color of group ${group.id}:`,
            error
          );
        }
      }
    )
  );
}

// -----------------------------------------------------------------------------
// Ungroup tabs no longer matching a modified rule
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
    matchingGroups.map(
      group =>
        enqueueWindowOperation(
          group.windowId,
          async () => {
            let tabs;

            try {
              tabs =
                await browser.tabs.query({
                  groupId:
                    group.id
                });
            } catch (error) {
              console.warn(
                `Could not query tabs for group ${group.id}:`,
                error
              );

              return;
            }

            const tabsToUngroup =
              tabs
                .filter(
                  tab =>
                    !tab.url ||
                    !wildcardMatch(
                      tab.url,
                      newPattern
                    )
                )
                .map(
                  tab => tab.id
                )
                .filter(
                  id => id != null
                );

            if (
              tabsToUngroup.length ===
              0
            ) {
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
// Runtime messages
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

    if (
      message.action ===
      "sortAllGroups"
    ) {
      return sortAllGroups()
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
// URL changes
// -----------------------------------------------------------------------------

browser.tabs.onUpdated.addListener(
  (
    tabId,
    changeInfo,
    tab
  ) => {
    if (!changeInfo.url) {
      return;
    }

    if (
      tab.windowId == null
    ) {
      return;
    }

    enqueueWindowOperation(
      tab.windowId,
      async () => {
        await applyRuleToTab(
          tabId
        );

        await sortGroupsInWindow(
          tab.windowId
        );
      }
    ).catch(error => {
      console.error(
        `Could not process updated tab ${tabId}:`,
        error
      );
    });
  }
);

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------

async function initialize() {
  await migrateStorage();

  await applyRulesToAllTabs();

  console.log(
    "Auto Group Tabs background initialized"
  );
}

initialize().catch(error => {
  console.error(
    "Auto Group Tabs initialization failed:",
    error
  );
});
