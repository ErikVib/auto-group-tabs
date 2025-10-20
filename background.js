// Helper: wildcard match
function wildcardMatch(url, pattern) {
  try {
    // Normalize both sides
    const u = new URL(url);
    const target = `${u.hostname}${u.pathname}${u.search}`;

    // Normalize the pattern
    let p = pattern
      .replace(/^https?:\/\//, "") // remove scheme
      .replace(/^www\./, "")       // ignore www.
      .replace(/\*/g, ".*")        // wildcard
      .replace(/\./g, "\\.");      // escape dots

    // Build regex
    const regex = new RegExp(p, "i");

    // Compare against both hostname and full host+path
    return regex.test(u.hostname) || regex.test(target);
  } catch (e) {
    console.error("wildcardMatch error:", e);
    return false;
  }
}

// Apply rules to all existing tabs
async function applyRulesToAllTabs() {
  const { groups = [], groupMap = {}, groupUnmatched = true } = await browser.storage.local.get(["groups", "groupMap", "groupUnmatched"]);
  const tabs = await browser.tabs.query({});
  const unmatchedTabs = [];

  for (const tab of tabs) {
    if (!tab.url) continue;

    let matched = false;
    for (const g of groups) {
      if (wildcardMatch(tab.url, g.pattern)) {
        matched = true;
        console.log(`Applying rule "${g.name}" to tab: ${tab.url}`);

        try {
          let groupId = groupMap[g.name];

          // Check if that group still exists
          let stillValid = false;
          if (groupId && browser.tabGroups?.get) {
            try {
              await browser.tabGroups.get(groupId);
              stillValid = true;
            } catch {
              stillValid = false;
            }
          }

          if (!stillValid) {
            console.log("Creating new group for", g.name);
            groupId = await browser.tabs.group({
              tabIds: [tab.id],
              createProperties: { windowId: tab.windowId }
            });
            groupMap[g.name] = groupId;
            await browser.storage.local.set({ groupMap });
          } else {
            console.log("Adding tab to existing group:", g.name, groupId);
            await browser.tabs.group({
              groupId,
              tabIds: [tab.id]
            });
          }

          // Update group title/color
          if (browser.tabGroups?.update) {
            try {
              await browser.tabGroups.update(groupId, {
                title: g.name,
                color: g.color || "blue"
              });
            } catch (e) {
              console.warn("Could not update group title/color:", e);
            }
          }

        } catch (err) {
          console.error("Error grouping tab:", err);
        }

        break;
      }
    }

    // If no pattern matched
    if (!matched) {
      if (groupUnmatched) {
        unmatchedTabs.push(tab);
      } else {
        // Ungroup the tab if it's in a group
        try {
          if (tab.groupId && tab.groupId !== -1) {
            console.log(`Ungrouping tab ${tab.id} - URL no longer matches any pattern`);
            await browser.tabs.ungroup([tab.id]);
          }
        } catch (err) {
          console.error("Error ungrouping tab:", err);
        }
      }
    }
  }

  // Group all unmatched tabs together if setting is enabled
  if (groupUnmatched && unmatchedTabs.length > 0) {
    try {
      let etcGroupId = groupMap["etc"];
      
      // Check if "etc" group still exists
      let stillValid = false;
      if (etcGroupId && browser.tabGroups?.get) {
        try {
          await browser.tabGroups.get(etcGroupId);
          stillValid = true;
        } catch {
          stillValid = false;
        }
      }

      if (!stillValid) {
        console.log("Creating 'etc' group for unmatched tabs");
        etcGroupId = await browser.tabs.group({
          tabIds: unmatchedTabs.map(t => t.id),
          createProperties: { windowId: unmatchedTabs[0].windowId }
        });
        groupMap["etc"] = etcGroupId;
        await browser.storage.local.set({ groupMap });
      } else {
        console.log("Adding unmatched tabs to 'etc' group");
        for (const tab of unmatchedTabs) {
          try {
            await browser.tabs.group({
              groupId: etcGroupId,
              tabIds: [tab.id]
            });
          } catch (err) {
            console.error("Error adding tab to etc group:", err);
          }
        }
      }

      // Update "etc" group appearance
      if (browser.tabGroups?.update) {
        try {
          await browser.tabGroups.update(etcGroupId, {
            title: "etc",
            color: "grey"
          });
        } catch (e) {
          console.warn("Could not update etc group:", e);
        }
      }
    } catch (err) {
      console.error("Error creating etc group:", err);
    }
  }
}

// Update color of existing group
async function updateGroupColor(groupName, newColor) {
  const { groupMap = {} } = await browser.storage.local.get("groupMap");
  const groupId = groupMap[groupName];

  if (groupId && browser.tabGroups?.update) {
    try {
      await browser.tabGroups.update(groupId, {
        color: newColor
      });
      console.log(`Updated color of group "${groupName}" to ${newColor}`);
    } catch (e) {
      console.warn("Could not update group color:", e);
    }
  }
}

// Ungroup tabs that no longer match a pattern
async function ungroupMismatchedTabs(groupName, newPattern) {
  const { groupMap = {} } = await browser.storage.local.get("groupMap");
  const groupId = groupMap[groupName];

  if (!groupId) return;

  try {
    const tabs = await browser.tabs.query({ groupId });
    const tabsToUngroup = [];

    for (const tab of tabs) {
      if (!tab.url || !wildcardMatch(tab.url, newPattern)) {
        tabsToUngroup.push(tab.id);
      }
    }

    if (tabsToUngroup.length > 0) {
      await browser.tabs.ungroup(tabsToUngroup);
      console.log(`Ungrouped ${tabsToUngroup.length} tabs from "${groupName}" that no longer match`);
    }
  } catch (err) {
    console.error("Error ungrouping mismatched tabs:", err);
  }
}

// Listen for messages from options/popup
browser.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  if (message.action === "applyRulesToAllTabs") {
    await applyRulesToAllTabs();
    sendResponse({ success: true });
  } else if (message.action === "updateGroupColor") {
    await updateGroupColor(message.groupName, message.newColor);
    sendResponse({ success: true });
  } else if (message.action === "ungroupMismatchedTabs") {
    await ungroupMismatchedTabs(message.groupName, message.newPattern);
    sendResponse({ success: true });
  }
  return true; // Keep message channel open for async response
});

// Handle tab updates
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  const { groups = [], groupMap = {}, groupUnmatched = true } = await browser.storage.local.get(["groups", "groupMap", "groupUnmatched"]);

  for (const g of groups) {
    if (wildcardMatch(changeInfo.url, g.pattern)) {
      console.log(`Matched pattern "${g.pattern}" for group "${g.name}"`);

      try {
        let groupId = groupMap[g.name];

        // Check if that group still exists
        let stillValid = false;
        if (groupId && browser.tabGroups?.get) {
          try {
            await browser.tabGroups.get(groupId);
            stillValid = true;
          } catch {
            stillValid = false;
          }
        }

        if (!stillValid) {
          console.log("Creating new group for", g.name);
          groupId = await browser.tabs.group({
            tabIds: [tabId],
            createProperties: { windowId: tab.windowId }
          });
          groupMap[g.name] = groupId;
          await browser.storage.local.set({ groupMap });
        } else {
          console.log("Adding tab to existing group:", g.name, groupId);
          await browser.tabs.group({
            groupId,
            tabIds: [tabId]
          });
        }

        // Optionally try to name/color it (future-safe)
        if (browser.tabGroups?.update) {
          try {
            await browser.tabGroups.update(groupId, {
              title: g.name,
              color: g.color || "blue"
            });
          } catch (e) {
            console.warn("Could not update group title/color:", e);
          }
        }

      } catch (err) {
        console.error("Error grouping tab:", err);
      }

      return;
    }
  }

  // No pattern matched
  if (groupUnmatched) {
    // Add to "etc" group
    try {
      let etcGroupId = groupMap["etc"];
      
      // Check if "etc" group still exists
      let stillValid = false;
      if (etcGroupId && browser.tabGroups?.get) {
        try {
          await browser.tabGroups.get(etcGroupId);
          stillValid = true;
        } catch {
          stillValid = false;
        }
      }

      if (!stillValid) {
        console.log("Creating 'etc' group");
        etcGroupId = await browser.tabs.group({
          tabIds: [tabId],
          createProperties: { windowId: tab.windowId }
        });
        groupMap["etc"] = etcGroupId;
        await browser.storage.local.set({ groupMap });
      } else {
        console.log("Adding tab to 'etc' group");
        await browser.tabs.group({
          groupId: etcGroupId,
          tabIds: [tabId]
        });
      }

      // Update "etc" group appearance
      if (browser.tabGroups?.update) {
        try {
          await browser.tabGroups.update(etcGroupId, {
            title: "etc",
            color: "grey"
          });
        } catch (e) {
          console.warn("Could not update etc group:", e);
        }
      }
    } catch (err) {
      console.error("Error adding to etc group:", err);
    }
  } else {
    // Ungroup the tab if it's in a group
    try {
      const updatedTab = await browser.tabs.get(tabId);
      if (updatedTab.groupId && updatedTab.groupId !== -1) {
        console.log(`Ungrouping tab ${tabId} - URL no longer matches any pattern`);
        await browser.tabs.ungroup([tabId]);
      }
    } catch (err) {
      console.error("Error ungrouping tab:", err);
    }
  }
});
