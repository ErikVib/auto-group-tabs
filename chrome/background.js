// Helper: wildcard match
function wildcardMatch(url, pattern) {
  try {
    const u = new URL(url);
    const target = `${u.hostname}${u.pathname}${u.search}`;

    let p = pattern
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\*/g, ".*")
      .replace(/\./g, "\\.");

    const regex = new RegExp(p, "i");
    return regex.test(u.hostname) || regex.test(target);
  } catch (e) {
    console.error("wildcardMatch error:", e);
    return false;
  }
}

// Apply rules to all existing tabs
async function applyRulesToAllTabs() {
  const { groups = [], groupMap = {}, groupUnmatched = true } = await chrome.storage.local.get(["groups", "groupMap", "groupUnmatched"]);
  const tabs = await chrome.tabs.query({});
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
          if (groupId !== undefined && groupId !== -1) {
            try {
              await chrome.tabGroups.get(groupId);
              stillValid = true;
            } catch {
              stillValid = false;
            }
          }

          if (!stillValid) {
            console.log("Creating new group for", g.name);
            groupId = await chrome.tabs.group({
              tabIds: [tab.id]
            });
            groupMap[g.name] = groupId;
            await chrome.storage.local.set({ groupMap });
          } else {
            console.log("Adding tab to existing group:", g.name, groupId);
            await chrome.tabs.group({
              groupId,
              tabIds: [tab.id]
            });
          }

          // Update group title/color
          await chrome.tabGroups.update(groupId, {
            title: g.name,
            color: g.color || "blue"
          });

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
            await chrome.tabs.ungroup([tab.id]);
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
      if (etcGroupId !== undefined && etcGroupId !== -1) {
        try {
          await chrome.tabGroups.get(etcGroupId);
          stillValid = true;
        } catch {
          stillValid = false;
        }
      }

      if (!stillValid) {
        console.log("Creating 'etc' group for unmatched tabs");
        etcGroupId = await chrome.tabs.group({
          tabIds: unmatchedTabs.map(t => t.id)
        });
        groupMap["etc"] = etcGroupId;
        await chrome.storage.local.set({ groupMap });
      } else {
        console.log("Adding unmatched tabs to 'etc' group");
        for (const tab of unmatchedTabs) {
          try {
            await chrome.tabs.group({
              groupId: etcGroupId,
              tabIds: [tab.id]
            });
          } catch (err) {
            console.error("Error adding tab to etc group:", err);
          }
        }
      }

      // Update "etc" group appearance
      await chrome.tabGroups.update(etcGroupId, {
        title: "etc",
        color: "grey"
      });
    } catch (err) {
      console.error("Error creating etc group:", err);
    }
  }
}

// Update color of existing group
async function updateGroupColor(groupName, newColor) {
  const { groupMap = {} } = await chrome.storage.local.get("groupMap");
  const groupId = groupMap[groupName];

  if (groupId !== undefined && groupId !== -1) {
    try {
      await chrome.tabGroups.update(groupId, {
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
  const { groupMap = {} } = await chrome.storage.local.get("groupMap");
  const groupId = groupMap[groupName];

  if (!groupId) return;

  try {
    const tabs = await chrome.tabs.query({ groupId });
    const tabsToUngroup = [];

    for (const tab of tabs) {
      if (!tab.url || !wildcardMatch(tab.url, newPattern)) {
        tabsToUngroup.push(tab.id);
      }
    }

    if (tabsToUngroup.length > 0) {
      await chrome.tabs.ungroup(tabsToUngroup);
      console.log(`Ungrouped ${tabsToUngroup.length} tabs from "${groupName}" that no longer match`);
    }
  } catch (err) {
    console.error("Error ungrouping mismatched tabs:", err);
  }
}

// Listen for messages from options/popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "applyRulesToAllTabs") {
    applyRulesToAllTabs().then(() => {
      sendResponse({ success: true });
    });
  } else if (message.action === "updateGroupColor") {
    updateGroupColor(message.groupName, message.newColor).then(() => {
      sendResponse({ success: true });
    });
  } else if (message.action === "ungroupMismatchedTabs") {
    ungroupMismatchedTabs(message.groupName, message.newPattern).then(() => {
      sendResponse({ success: true });
    });
  }
  return true;
});

// Handle tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  const { groups = [], groupMap = {}, groupUnmatched = true } = await chrome.storage.local.get(["groups", "groupMap", "groupUnmatched"]);

  for (const g of groups) {
    if (wildcardMatch(changeInfo.url, g.pattern)) {
      console.log(`Matched pattern "${g.pattern}" for group "${g.name}"`);

      try {
        let groupId = groupMap[g.name];

        // Check if that group still exists
        let stillValid = false;
        if (groupId !== undefined && groupId !== -1) {
          try {
            await chrome.tabGroups.get(groupId);
            stillValid = true;
          } catch {
            stillValid = false;
          }
        }

        if (!stillValid) {
          console.log("Creating new group for", g.name);
          groupId = await chrome.tabs.group({
            tabIds: [tabId]
          });
          groupMap[g.name] = groupId;
          await chrome.storage.local.set({ groupMap });
        } else {
          console.log("Adding tab to existing group:", g.name, groupId);
          await chrome.tabs.group({
            groupId,
            tabIds: [tabId]
          });
        }

        // Update group title/color
        await chrome.tabGroups.update(groupId, {
          title: g.name,
          color: g.color || "blue"
        });

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
      if (etcGroupId !== undefined && etcGroupId !== -1) {
        try {
          await chrome.tabGroups.get(etcGroupId);
          stillValid = true;
        } catch {
          stillValid = false;
        }
      }

      if (!stillValid) {
        console.log("Creating 'etc' group");
        etcGroupId = await chrome.tabs.group({
          tabIds: [tabId]
        });
        groupMap["etc"] = etcGroupId;
        await chrome.storage.local.set({ groupMap });
      } else {
        console.log("Adding tab to 'etc' group");
        await chrome.tabs.group({
          groupId: etcGroupId,
          tabIds: [tabId]
        });
      }

      // Update "etc" group appearance
      await chrome.tabGroups.update(etcGroupId, {
        title: "etc",
        color: "grey"
      });
    } catch (err) {
      console.error("Error adding to etc group:", err);
    }
  } else {
    // Ungroup the tab if it's in a group
    try {
      const updatedTab = await chrome.tabs.get(tabId);
      if (updatedTab.groupId && updatedTab.groupId !== -1) {
        console.log(`Ungrouping tab ${tabId} - URL no longer matches any pattern`);
        await chrome.tabs.ungroup([tabId]);
      }
    } catch (err) {
      console.error("Error ungrouping tab:", err);
    }
  }
});
