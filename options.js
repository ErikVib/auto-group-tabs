const colorMap = {
  blue: '#4A90E2',
  yellow: '#F5A623',
  red: '#D0021B',
  green: '#7ED321',
  purple: '#9013FE',
  orange: '#F5A623',
  pink: '#F78DA7',
  cyan: '#50E3C2',
  gray: '#9B9B9B'
};

let editingIndex = null;

async function refreshList() {
  const { groups = [] } = await browser.storage.local.get("groups");
  const list = document.getElementById("groupList");
  list.innerHTML = "";
  
  if (groups.length === 0) {
    list.innerHTML = '<div class="empty-message">No rules configured yet. Add one below!</div>';
    return;
  }
  
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const li = document.createElement("li");
    
    const colorIndicator = document.createElement("span");
    colorIndicator.className = "color-indicator";
    colorIndicator.style.backgroundColor = colorMap[g.color] || colorMap.blue;
    
    const infoDiv = document.createElement("div");
    infoDiv.className = "group-info";
    
    const nameDiv = document.createElement("div");
    nameDiv.className = "group-name";
    nameDiv.innerHTML = colorIndicator.outerHTML + g.name;
    
    const patternDiv = document.createElement("div");
    patternDiv.className = "group-pattern";
    patternDiv.textContent = g.pattern;
    
    infoDiv.appendChild(nameDiv);
    infoDiv.appendChild(patternDiv);
    
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    
    const editBtn = document.createElement("button");
    editBtn.className = "edit-btn";
    editBtn.innerHTML = "&#9998;"; // Pen icon
    editBtn.title = "Edit rule";
    editBtn.onclick = () => {
      editingIndex = i;
      document.getElementById("groupFormTitle").textContent = "Edit Rule";
      document.getElementById("name").value = g.name;
      document.getElementById("pattern").value = g.pattern;
      document.getElementById("color").value = g.color;
      document.getElementById("submitBtn").textContent = "Update Rule";
      document.getElementById("cancelBtn").style.display = "inline-block";
      document.getElementById("name").focus();
      document.querySelector('.section:last-child').scrollIntoView({ behavior: 'smooth' });
    };
    
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.innerHTML = "&#10005;"; // X icon
    deleteBtn.title = "Delete rule";
    deleteBtn.onclick = async () => {
      if (confirm(`Delete rule "${g.name}"?`)) {
        groups.splice(i, 1);
        await browser.storage.local.set({ groups });
        refreshList();
      }
    };
    
    buttonContainer.appendChild(editBtn);
    buttonContainer.appendChild(deleteBtn);
    
    li.appendChild(infoDiv);
    li.appendChild(buttonContainer);
    list.appendChild(li);
  }
}

function cancelEdit() {
  editingIndex = null;
  document.getElementById("groupForm").reset();
  document.getElementById("groupFormTitle").textContent = "Add New Rule";
  document.getElementById("submitBtn").textContent = "Add Rule";
  document.getElementById("cancelBtn").style.display = "none";
}

document.getElementById("groupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  const pattern = document.getElementById("pattern").value.trim();
  const color = document.getElementById("color").value;

  if (!name || !pattern) {
    alert("Please fill in both name and pattern");
    return;
  }

  const { groups = [] } = await browser.storage.local.get("groups");
  
  if (editingIndex !== null) {
    // Update existing rule
    const oldRule = groups[editingIndex];
    const colorChanged = oldRule.color !== color;
    const patternChanged = oldRule.pattern !== pattern;
    
    groups[editingIndex] = { name, pattern, color };
    await browser.storage.local.set({ groups });
    
    // If color changed, update the existing group's color
    if (colorChanged) {
      await browser.runtime.sendMessage({
        action: "updateGroupColor",
        groupName: name,
        newColor: color
      });
    }
    
    // If pattern changed, ungroup tabs that no longer match
    if (patternChanged) {
      await browser.runtime.sendMessage({
        action: "ungroupMismatchedTabs",
        groupName: name,
        newPattern: pattern
      });
      // Then apply the new pattern to all tabs
      await browser.runtime.sendMessage({
        action: "applyRulesToAllTabs"
      });
    }
    
    editingIndex = null;
  } else {
    // Check for duplicate names when adding
    if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
      alert(`A rule named "${name}" already exists`);
      return;
    }
    groups.push({ name, pattern, color });
    await browser.storage.local.set({ groups });
    
    // Apply new rule to all existing tabs
    await browser.runtime.sendMessage({
      action: "applyRulesToAllTabs"
    });
  }

  e.target.reset();
  document.getElementById("submitBtn").textContent = "Add Rule";
  document.getElementById("groupFormTitle").textContent = "Add New Rule";
  document.getElementById("cancelBtn").style.display = "none";
  refreshList();
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
refreshList();
