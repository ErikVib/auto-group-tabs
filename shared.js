// Shared utilities and constants

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

const availableColors = ['blue', 'yellow', 'red', 'green', 'purple', 'orange', 'pink', 'cyan', 'gray'];

let editingIndex = null;

function selectUnusedColor() {
  browser.storage.local.get("groups").then(({ groups = [] }) => {
    const usedColors = groups.map(g => g.color);
    const unusedColor = availableColors.find(color => !usedColors.includes(color));
    
    const colorSelect = document.getElementById("color");
    if (unusedColor && colorSelect) {
      colorSelect.value = unusedColor;
    }
  });
}

async function refreshList(listElementId) {
  const { groups = [] } = await browser.storage.local.get("groups");
  const list = document.getElementById(listElementId);
  list.innerHTML = "";
  
  if (groups.length === 0) {
    list.innerHTML = '<div class="empty-message">No rules configured yet' + 
      (listElementId === 'groupList' ? '. Add one below!' : '') + '</div>';
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
    editBtn.innerHTML = "&#9998;";
    editBtn.title = "Edit rule";
    editBtn.onclick = () => startEdit(i, g);
    
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.innerHTML = "&#10005;";
    deleteBtn.title = "Delete rule";
    deleteBtn.onclick = () => deleteRule(i, g.name, listElementId);
    
    buttonContainer.appendChild(editBtn);
    buttonContainer.appendChild(deleteBtn);
    
    li.appendChild(infoDiv);
    li.appendChild(buttonContainer);
    list.appendChild(li);
  }
  
  // Update color picker to select unused color when not editing
  if (editingIndex === null) {
    selectUnusedColor();
  }
}

function startEdit(index, rule) {
  editingIndex = index;
  document.getElementById("name").value = rule.name;
  document.getElementById("pattern").value = rule.pattern;
  document.getElementById("color").value = rule.color;
  document.getElementById("submitBtn").textContent = "Update Rule";
  document.getElementById("cancelBtn").style.display = "inline-block";
  document.getElementById("name").focus();
  
  // Scroll to form if on options page
  const formTitle = document.getElementById("groupFormTitle");
  if (formTitle) {
    formTitle.textContent = "Edit Rule";
    document.querySelector('.section:last-child').scrollIntoView({ behavior: 'smooth' });
  }
}

async function deleteRule(index, name, listElementId) {
  const shouldDelete = window.confirm ? confirm(`Delete rule "${name}"?`) : true;
  if (!shouldDelete) return;
  
  const { groups = [] } = await browser.storage.local.get("groups");
  groups.splice(index, 1);
  await browser.storage.local.set({ groups });
  refreshList(listElementId);
}

function cancelEdit() {
  editingIndex = null;
  document.getElementById("groupForm").reset();
  document.getElementById("submitBtn").textContent = "Add Rule";
  document.getElementById("cancelBtn").style.display = "none";
  
  const formTitle = document.getElementById("groupFormTitle");
  if (formTitle) {
    formTitle.textContent = "Add New Rule";
  }
  
  // Select an unused color for the next rule
  selectUnusedColor();
}

async function handleFormSubmit(e, listElementId) {
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
  document.getElementById("cancelBtn").style.display = "none";
  
  const formTitle = document.getElementById("groupFormTitle");
  if (formTitle) {
    formTitle.textContent = "Add New Rule";
  }
  
  refreshList(listElementId);
}
