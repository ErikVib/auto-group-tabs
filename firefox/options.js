// Auto Group Tabs - Options page

const EXPORT_SCHEMA = "auto-group-tabs";
const EXPORT_VERSION = 1;
const MAX_IMPORT_FILE_SIZE = 1024 * 1024; // 1 MB

const STORAGE_COLORS = new Set([
  "blue",
  "yellow",
  "red",
  "green",
  "purple",
  "orange",
  "pink",
  "cyan",
  "gray"
]);

// -----------------------------------------------------------------------------
// Existing settings / rule editor
// -----------------------------------------------------------------------------

document
  .getElementById("groupForm")
  .addEventListener("submit", (event) => {
    handleFormSubmit(event, "groupList");
  });

document
  .getElementById("cancelBtn")
  .addEventListener("click", cancelEdit);

async function loadSettings() {
  const {
    groupUnmatched = true
  } = await browser.storage.local.get("groupUnmatched");

  document.getElementById(
    "groupUnmatched"
  ).checked = groupUnmatched;
}

document
  .getElementById("groupUnmatched")
  .addEventListener("change", async (event) => {
    const groupUnmatched = event.target.checked;

    await browser.storage.local.set({
      groupUnmatched
    });

    await applyRules();
  });

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

function showStatus(message, type = "info") {
  const element =
    document.getElementById("backupStatus");

  element.textContent = message;
  element.className = `status ${type}`;
}

function clearStatus() {
  const element =
    document.getElementById("backupStatus");

  element.textContent = "";
  element.className = "status";
}

// -----------------------------------------------------------------------------
// Rule validation
// -----------------------------------------------------------------------------

function normalizeStorageColor(color) {
  if (typeof color !== "string") {
    return "blue";
  }

  const normalized =
    color.trim().toLowerCase();

  // Firefox's tabGroups API calls this color "grey",
  // while the existing extension stores it as "gray".
  if (normalized === "grey") {
    return "gray";
  }

  if (STORAGE_COLORS.has(normalized)) {
    return normalized;
  }

  return "blue";
}

function validateAndNormalizeRule(
  rule,
  index
) {
  if (
    !rule ||
    typeof rule !== "object" ||
    Array.isArray(rule)
  ) {
    throw new Error(
      `Rule ${index + 1} is not a valid object.`
    );
  }

  if (
    typeof rule.name !== "string" ||
    !rule.name.trim()
  ) {
    throw new Error(
      `Rule ${index + 1} has no group name.`
    );
  }

  if (
    typeof rule.pattern !== "string" ||
    !rule.pattern.trim()
  ) {
    throw new Error(
      `Rule "${rule.name}" has no URL pattern.`
    );
  }

  return {
    name: rule.name.trim(),
    pattern: rule.pattern.trim(),
    color: normalizeStorageColor(rule.color)
  };
}

function validateRuleNames(groups) {
  const seen = new Set();

  for (const rule of groups) {
    const key =
      rule.name.trim().toLowerCase();

    if (seen.has(key)) {
      throw new Error(
        `The import contains more than one rule named "${rule.name}".`
      );
    }

    seen.add(key);
  }
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

async function exportRules() {
  clearStatus();

  try {
    const {
      groups = [],
      groupUnmatched = true
    } = await browser.storage.local.get([
      "groups",
      "groupUnmatched"
    ]);

    const normalizedGroups =
      groups.map((rule, index) =>
        validateAndNormalizeRule(
          rule,
          index
        )
      );

    const backup = {
      schema: EXPORT_SCHEMA,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      settings: {
        groupUnmatched
      },
      groups: normalizedGroups
    };

    const json =
      JSON.stringify(
        backup,
        null,
        2
      );

    const blob =
      new Blob(
        [json],
        {
          type: "application/json"
        }
      );

    const objectUrl =
      URL.createObjectURL(blob);

    const date =
      new Date()
        .toISOString()
        .slice(0, 10);

    const filename =
      `auto-group-tabs-rules-${date}.json`;

    const anchor =
      document.createElement("a");

    anchor.href = objectUrl;
    anchor.download = filename;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    // Firefox needs the object URL long enough
    // for the download to start.
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1000);

    showStatus(
      `Exported ${normalizedGroups.length} rule(s).`,
      "success"
    );
  } catch (error) {
    console.error(
      "Export failed:",
      error
    );

    showStatus(
      `Export failed: ${error.message}`,
      "error"
    );
  }
}

// -----------------------------------------------------------------------------
// Import parsing
// -----------------------------------------------------------------------------

function parseBackupPayload(data) {
  /*
   * Supported formats:
   *
   * Current:
   *
   * {
   *   "schema": "auto-group-tabs",
   *   "version": 1,
   *   "settings": {
   *     "groupUnmatched": true
   *   },
   *   "groups": [...]
   * }
   *
   * Earlier/simple format:
   *
   * {
   *   "version": 1,
   *   "groupUnmatched": true,
   *   "groups": [...]
   * }
   *
   * Also accepts a raw array of rules:
   *
   * [
   *   { "name": "...", "pattern": "...", "color": "..." }
   * ]
   */

  let rawGroups;
  let importedGroupUnmatched;

  if (Array.isArray(data)) {
    rawGroups = data;
  } else if (
    data &&
    typeof data === "object"
  ) {
    if (
      data.schema &&
      data.schema !== EXPORT_SCHEMA
    ) {
      throw new Error(
        `Unsupported backup schema: ${data.schema}`
      );
    }

    if (
      data.version != null &&
      data.version > EXPORT_VERSION
    ) {
      throw new Error(
        `This backup uses version ${data.version}. ` +
        `This extension supports up to version ${EXPORT_VERSION}.`
      );
    }

    rawGroups = data.groups;

    if (
      data.settings &&
      typeof data.settings.groupUnmatched === "boolean"
    ) {
      importedGroupUnmatched =
        data.settings.groupUnmatched;
    } else if (
      typeof data.groupUnmatched === "boolean"
    ) {
      // Compatibility with the simple format.
      importedGroupUnmatched =
        data.groupUnmatched;
    }
  }

  if (!Array.isArray(rawGroups)) {
    throw new Error(
      'The backup does not contain a valid "groups" array.'
    );
  }

  const groups =
    rawGroups.map(
      (rule, index) =>
        validateAndNormalizeRule(
          rule,
          index
        )
    );

  validateRuleNames(groups);

  return {
    groups,
    groupUnmatched:
      importedGroupUnmatched
  };
}

// -----------------------------------------------------------------------------
// Merge
// -----------------------------------------------------------------------------

function mergeGroups(
  existingGroups,
  importedGroups
) {
  const result =
    existingGroups.map(
      (rule, index) =>
        validateAndNormalizeRule(
          rule,
          index
        )
    );

  const indexByName =
    new Map();

  result.forEach(
    (rule, index) => {
      indexByName.set(
        rule.name.toLowerCase(),
        index
      );
    }
  );

  for (const importedRule of importedGroups) {
    const key =
      importedRule.name.toLowerCase();

    const existingIndex =
      indexByName.get(key);

    if (existingIndex == null) {
      indexByName.set(
        key,
        result.length
      );

      result.push(importedRule);
    } else {
      // Imported version wins.
      result[existingIndex] =
        importedRule;
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// Import
// -----------------------------------------------------------------------------

function getImportMode() {
  return (
    document.querySelector(
      'input[name="importMode"]:checked'
    )?.value || "replace"
  );
}

async function importRules(file) {
  clearStatus();

  if (!file) {
    return;
  }

  if (
    file.size >
    MAX_IMPORT_FILE_SIZE
  ) {
    showStatus(
      "Import failed: the selected file is larger than 1 MB.",
      "error"
    );

    return;
  }

  try {
    const text =
      await file.text();

    let data;

    try {
      data =
        JSON.parse(text);
    } catch {
      throw new Error(
        "The selected file is not valid JSON."
      );
    }

    const imported =
      parseBackupPayload(data);

    const mode =
      getImportMode();

    let finalGroups;

    if (mode === "merge") {
      const {
        groups: existingGroups = []
      } =
        await browser.storage.local.get(
          "groups"
        );

      finalGroups =
        mergeGroups(
          existingGroups,
          imported.groups
        );
    } else {
      finalGroups =
        imported.groups;
    }

    const storageUpdate = {
      groups: finalGroups
    };

    if (
      typeof imported.groupUnmatched ===
      "boolean"
    ) {
      storageUpdate.groupUnmatched =
        imported.groupUnmatched;
    }

    await browser.storage.local.set(
      storageUpdate
    );

    /*
     * Never restore groupMap.
     *
     * Old versions of the extension persisted Firefox group IDs.
     * Those IDs aren't stable browser state and shouldn't be
     * transferred in a backup.
     */
    await browser.storage.local.remove(
      "groupMap"
    );

    await loadSettings();
    await refreshList("groupList");
    await applyRules();

    if (mode === "merge") {
      showStatus(
        `Import complete. ${imported.groups.length} rule(s) imported, ` +
        `${finalGroups.length} rule(s) now configured.`,
        "success"
      );
    } else {
      showStatus(
        `Import complete. ${finalGroups.length} rule(s) restored.`,
        "success"
      );
    }
  } catch (error) {
    console.error(
      "Import failed:",
      error
    );

    showStatus(
      `Import failed: ${error.message}`,
      "error"
    );
  }
}

// -----------------------------------------------------------------------------
// Reapply grouping
// -----------------------------------------------------------------------------

async function applyRules() {
  try {
    await browser.runtime.sendMessage({
      action: "applyRulesToAllTabs"
    });
  } catch (error) {
    /*
     * Storage has already been saved, so don't roll back the import.
     * Show the error because tabs might not have been reorganized yet.
     */
    console.error(
      "Rules saved but tabs could not be reorganized:",
      error
    );

    showStatus(
      "Rules were saved, but existing tabs could not be reorganized. " +
      "Reload the extension and use Apply Rules again.",
      "error"
    );
  }
}

// -----------------------------------------------------------------------------
// Buttons
// -----------------------------------------------------------------------------

document
  .getElementById("exportRules")
  .addEventListener(
    "click",
    exportRules
  );

document
  .getElementById("importRules")
  .addEventListener(
    "click",
    () => {
      clearStatus();

      document
        .getElementById("importFile")
        .click();
    }
  );

document
  .getElementById("importFile")
  .addEventListener(
    "change",
    async (event) => {
      const file =
        event.target.files?.[0];

      await importRules(file);

      // Allows selecting the same file again.
      event.target.value = "";
    }
  );

// -----------------------------------------------------------------------------
// Initial load
// -----------------------------------------------------------------------------

loadSettings();
refreshList("groupList");
