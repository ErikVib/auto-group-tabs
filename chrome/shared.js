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
  grey: '#9B9B9B'
};

const availableColors = ['blue', 'yellow', 'red', 'green', 'purple', 'orange', 'pink', 'cyan', 'grey'];

let editingIndex = null;

function selectUnusedColor() {
  chrome.storage.local.get("groups").then(({ groups = [] }) => {
    const usedColors = groups.map(g => g.color);
    const unusedColor = availableColors.find(color => !usedColors.includes(color));
    
    const colorSelect = document.getElementById("color");
    if (unusedColor && colorSelect) {
      colorSelect.value = unusedColor;
    }
  });
}

async function refreshList(listElementId) {
  const { groups = [] } = await chrome.storage.local.get("groups");
  const list = document.getElementById(listElementId);
  list.innerHTML = "";
  
  if (groups.length === 0) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "empty-message";
    emptyDiv.textContent = 'No rules configured yet' + 
      (listElementId === 'groupList' ? '. Add one below!' : '');
    list.appendChild(emptyDiv);
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
    nameDiv.appendChild(colorIndicator.cloneNode(true));
    nameDiv.appendChild(document.createTextNode(g.name));
    
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
    editBtn.textContent = "✎";
    editBtn.title = "Edit rule";
    editBtn.onclick = () => startEdit(i, g);
    
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "✕";
    deleteBtn.title = "Delete rule";
    deleteBtn.onclick = () => deleteRule(i, g.name, listElementId);
    
    buttonContainer.appendChild(editBtn);
    buttonContainer.appendChild(deleteBtn);
    
    li.appendChild(infoDiv);
    li.appendChild(buttonContainer);
    list.appendChild(li);
  }
  
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
  
  const formTitle = document.getElementById("groupFormTitle");
  if (formTitle) {
    formTitle.textContent = "Edit Rule";
    document.querySelector('.section:last-child').scrollIntoView({ behavior: 'smooth' });
  }
}

async function deleteRule(index, name, listElementId) {
  const shouldDelete = window.confirm ? confirm(`Delete rule "${name}"?`) : true;
  if (!shouldDelete) return;
  
  const { groups = [] } = await chrome.storage.local.get("groups");
  groups.splice(index, 1);
  await chrome.storage.local.set({ groups });
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

  const { groups = [] } = await chrome.storage.local.get("groups");
  
  if (editingIndex !== null) {
    const oldRule = groups[editingIndex];
    const colorChanged = oldRule.color !== color;
    const patternChanged = oldRule.pattern !== pattern;
    
    groups[editingIndex] = { name, pattern, color };
    await chrome.storage.local.set({ groups });
    
    if (colorChanged) {
      await chrome.runtime.sendMessage({
        action: "updateGroupColor",
        groupName: name,
        newColor: color
      });
    }
    
    if (patternChanged) {
      await chrome.runtime.sendMessage({
        action: "ungroupMismatchedTabs",
        groupName: name,
        newPattern: pattern
      });
      await chrome.runtime.sendMessage({
        action: "applyRulesToAllTabs"
      });
    }
    
    editingIndex = null;
  } else {
    if (groups.some(g => g.name.toLowerCase() === name.toLowerCase())) {
      alert(`A rule named "${name}" already exists`);
      return;
    }
    groups.push({ name, pattern, color });
    await chrome.storage.local.set({ groups });
    
    await chrome.runtime.sendMessage({
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
