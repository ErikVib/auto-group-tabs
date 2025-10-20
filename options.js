// Main options page logic
document.getElementById("groupForm").addEventListener("submit", (e) => {
  handleFormSubmit(e, "groupList");
});

document.getElementById("cancelBtn").addEventListener("click", cancelEdit);

// Load and handle "group unmatched" setting
async function loadSettings() {
  const { groupUnmatched = true } = await browser.storage.local.get("groupUnmatched");
  document.getElementById("groupUnmatched").checked = groupUnmatched;
}

document.getElementById("groupUnmatched").addEventListener("change", async (e) => {
  const groupUnmatched = e.target.checked;
  await browser.storage.local.set({ groupUnmatched });
  
  // Apply rules to reorganize tabs
  await browser.runtime.sendMessage({
    action: "applyRulesToAllTabs"
  });
});

loadSettings();
refreshList("groupList");

