// PhotoBrowser.jsx  -- full file (replace your existing file with this)
import React, { useState } from "react";
import "./PhotoBrowser.css";

var storage = require("uxp").storage;
var dialogs = require("uxp").dialogs || (require("uxp").dialog && require("uxp").dialog);
var fs = storage.localFileSystem;
var batchPlay = require("photoshop").action.batchPlay;
var app = require("photoshop").app;

var imageExtRE = /\.(png|jpe?g|gif|webp|tif|tiff)$/i;

export default function PhotoBrowser() {
  var _useState = useState([]),
    photos = _useState[0],
    setPhotos = _useState[1];
  var _useState2 = useState(""),
    folderName = _useState2[0],
    setFolderName = _useState2[1];
  var _useState3 = useState(new Set()),
    selectedPhotos = _useState3[0],
    setSelectedPhotos = _useState3[1];
  var _useState4 = useState(""),
    alertMessage = _useState4[0],
    setAlertMessage = _useState4[1];
  var _useState5 = useState("Notice"),
    alertTitle = _useState5[0],
    setAlertTitle = _useState5[1];

  // Debug log state
  var _useState6 = useState([]),
    debugLogs = _useState6[0],
    setDebugLogs = _useState6[1];
  var _useState7 = useState(true),
    showLogPanel = _useState7[0],
    setShowLogPanel = _useState7[1];

  // central logging helper
  function appendLog() {
    try {
      var args = Array.prototype.slice.call(arguments);
      var msg = args.map(function (a) {
        try {
          if (typeof a === "object") return JSON.stringify(a);
          return String(a);
        } catch (e) {
          return String(a);
        }
      }).join(" ");
      // timestamp
      var ts = new Date().toISOString();
      var line = ts + "  " + msg;
      console.log(line);
      // keep last 500 logs only
      var newLogs = debugLogs.slice();
      newLogs.push(line);
      if (newLogs.length > 500) newLogs = newLogs.slice(newLogs.length - 500);
      setDebugLogs(newLogs);
    } catch (e) {
      console.log("appendLog error", e);
    }
  }

  // Diagnostic: dump document layer tree (limited depth)
  function dumpLayerTree() {
    try {
      var doc = app.activeDocument;
      if (!doc) {
        appendLog("No active document for dumpLayerTree()");
        return;
      }
      appendLog("Document:", doc.title || "(untitled)", "width:", doc.width, "height:", doc.height);
      function dumpLayersList(list, prefix, depth) {
        depth = depth || 0;
        for (var i = 0; i < list.length; i++) {
          try {
            var l = list[i];
            var id = l.id;
            var name = l.name;
            var visible = !!l.visible;
            var bounds = {};
            try {
              var b = l.bounds;
              bounds.left = (b.left && b.left.value !== undefined) ? b.left.value : b.left || 0;
              bounds.top = (b.top && b.top.value !== undefined) ? b.top.value : b.top || 0;
              bounds.right = (b.right && b.right.value !== undefined) ? b.right.value : b.right || 0;
              bounds.bottom = (b.bottom && b.bottom.value !== undefined) ? b.bottom.value : b.bottom || 0;
              bounds.w = bounds.right - bounds.left;
              bounds.h = bounds.bottom - bounds.top;
            } catch (e) {
              bounds = { left: 0, top: 0, right: 0, bottom: 0, w: 0, h: 0 };
            }
            appendLog(prefix + "[" + i + "] id:" + id + " name:\"" + name + "\" visible:" + visible + " bounds:" + JSON.stringify(bounds));
            if (l.layers && l.layers.length > 0) {
              dumpLayersList(l.layers, prefix + "  ", depth + 1);
            }
          } catch (e) {
            appendLog("dumpLayersList inner error", e);
          }
        }
      }
      dumpLayersList(doc.layers, "", 0);
    } catch (err) {
      appendLog("dumpLayerTree failed", err);
    }
  }

  // Diagnostic: show selected layers info
  function dumpSelectedLayersInfo() {
    try {
      var selected = app.activeDocument ? app.activeDocument.activeLayers : null;
      if (!selected) {
        appendLog("No selected layers");
        return;
      }
      appendLog("Active layers count:", selected.length);
      for (var i = 0; i < selected.length; i++) {
        var sl = selected[i];
        var slBounds = {};
        try {
          var sb = sl.bounds;
          slBounds.left = (sb.left && sb.left.value !== undefined) ? sb.left.value : sb.left || 0;
          slBounds.top = (sb.top && sb.top.value !== undefined) ? sb.top.value : sb.top || 0;
          slBounds.right = (sb.right && sb.right.value !== undefined) ? sb.right.value : sb.right || 0;
          slBounds.bottom = (sb.bottom && sb.bottom.value !== undefined) ? sb.bottom.value : sb.bottom || 0;
          slBounds.w = slBounds.right - slBounds.left;
          slBounds.h = slBounds.bottom - slBounds.top;
        } catch (e) {
          slBounds = { left: 0, top: 0, right: 0, bottom: 0, w: 0, h: 0 };
        }
        var parentName = "(none)";
        try {
          parentName = sl.parent ? sl.parent.name : parentName;
        } catch (e) {}
        appendLog("Selected[" + i + "] id:" + sl.id + " name:\"" + sl.name + "\" parent:" + parentName + " bounds:" + JSON.stringify(slBounds) + " visible:" + !!sl.visible);
      }
    } catch (err) {
      appendLog("dumpSelectedLayersInfo failed", err);
    }
  }

  // Copy logs to clipboard (fallback: show the log block)
  function copyLogsToClipboard() {
    try {
      var text = debugLogs.join("\n");
      // try navigator.clipboard (may not exist)
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          appendLog("Logs copied to clipboard (navigator.clipboard).");
        })["catch"](function (e) {
          appendLog("navigator.clipboard failed:", e);
          setAlertMessage("Failed to copy to clipboard. Please manually select the logs and copy.");
        });
      } else {
        setAlertMessage("Copy not supported in this environment. Use Manual select in the Logs panel.");
      }
    } catch (e) {
      appendLog("copyLogsToClipboard error", e);
    }
  }

  async function pickFolder() {
    try {
      var folder = await fs.getFolder();
      if (!folder) return;
      setFolderName(folder.name || folder.nativePath || "Selected folder");
      var entries = await folder.getEntries();
      var imageFiles = entries.filter(function (e) {
        return e.isFile && imageExtRE.test(e.name);
      });
      var items = await Promise.all(imageFiles.map(function (file) {
        return (async function () {
          var arrayBuffer = await file.read({ format: storage.formats.binary });
          var mime = /\.png$/i.test(file.name) ? "image/png" : "image/jpeg";
          var blob = new Blob([arrayBuffer], { type: mime });
          var url = URL.createObjectURL(blob);
          return { file: file, url: url, name: file.name };
        })();
      }));
      setPhotos(items);
      appendLog("Picked folder:", folder.name, "images:", items.length);
    } catch (err) {
      appendLog("Folder pick error:", err);
    }
  }

  function handleDragStart(e, item) {
    try {
      if (item.file.nativePath) {
        e.dataTransfer.setData("text/plain", item.file.nativePath);
      }
    } catch (err) {
      appendLog("drag start:", err);
    }
  }

  function togglePhotoSelection(item, event) {
    var newSelection = new Set(selectedPhotos);
    try {
      if (event.ctrlKey || event.metaKey) {
        if (newSelection.has(item.name)) {
          newSelection["delete"](item.name);
        } else {
          newSelection.add(item.name);
        }
      } else if (event.shiftKey && selectedPhotos.size > 0) {
        var photosList = photos.map(function (p) {
          return p.name;
        });
        var lastSelected = Array.from(selectedPhotos).pop();
        var fromIndex = photosList.indexOf(lastSelected);
        var toIndex = photosList.indexOf(item.name);
        var start = Math.min(fromIndex, toIndex),
          end = Math.max(fromIndex, toIndex);
        for (var i = start; i <= end; i++) {
          newSelection.add(photosList[i]);
        }
      } else {
        newSelection.clear();
        newSelection.add(item.name);
      }
      setSelectedPhotos(newSelection);
    } catch (e) {
      appendLog("togglePhotoSelection error", e);
    }
  }

  // ------------------------------
  // MAIN: placeSelectedIntoFrames()
  // ------------------------------
  async function placeSelectedIntoFrames() {
  try {
    const selectedLayers = app.activeDocument.activeLayers;
    const selectedItems = photos.filter((p) => selectedPhotos.has(p.name));

    if (!selectedLayers || selectedLayers.length === 0)
      throw new Error("No frames selected");
    if (!selectedItems || selectedItems.length === 0)
      throw new Error("No photos selected");

    const count = Math.min(selectedLayers.length, selectedItems.length);
    console.log("placeSelectedIntoFrames START", {
      layers: selectedLayers.length,
      photos: selectedItems.length,
      using: count,
    });

    await require("photoshop").core.executeAsModal(async () => {
      for (let i = 0; i < count; i++) {
        const frame = selectedLayers[i];
        const item = selectedItems[i];
        const token = await storage.localFileSystem.createSessionToken(item.file);

        console.log(`\n=== placing [${i}] ${item.name} into ${frame.name} ===`);

        // 1️⃣ Place photo as Smart Object
        await batchPlay([
          { _obj: "placeEvent", null: { _kind: "local", _path: token }, _isCommand: true },
          { _obj: "placedLayerConvertToSmartObject", _isCommand: true },
          { _obj: "commit", _isCommand: true }
        ], { synchronousExecution: true });

        let placed = app.activeDocument.activeLayers[0];

        await resizeAlTo(frame.bounds, 'fill');

        try {
        for (let j = 0; j < app.activeDocument.activeLayers.length; j++) {
        app.activeDocument.activeLayers[j].selected = false;
          }
          placed.selected = true;

          await batchPlay([
        {
            "_obj": "groupEvent",
            "_target": [
                {
                    "_enum": "ordinal",
                    "_ref": "layer",
                    "_value": "targetEnum"
                }
            ]
        }
    ]
, { synchronousExecution: true });

          console.log("Photo clipped strictly inside frame area.");
        } catch (e) {
          console.warn("clipping failed:", e);
        }
      }
    }, { commandName: "Place & Clip inside Frame (final)" });

    console.log("placeSelectedIntoFrames COMPLETE");
    setSelectedPhotos(new Set());
  } catch (err) {
    console.error("Batch place error:", err);
  }
}

async function resizeAlTo(mLayerB, scale) {
  try {
    var doc = app.activeDocument;
    var iLayer = doc.activeLayers[0];
    var layerBound = iLayer.boundsNoEffects || iLayer.bounds;
    var scaley = mLayerB.width / layerBound.width;
    var scalex = mLayerB.height / layerBound.height;
    var scaleMax = Math.max(scaley, scalex);
    var scaleMin = Math.min(scaley, scalex);
    if (scale == 'fill') {
      scaley = scalex = scaleMax;
    } else if (scale == 'fit') {
      scaley = scalex = scaleMin;
    } else if (scale == 'w') {
      scalex = 1;
    }
    await iLayer.scale(scaley * 100, scalex * 100);
    await iLayer.translate(((mLayerB.left + mLayerB.right) / 2) - ((layerBound.left + layerBound.right) / 2), ((mLayerB.top + mLayerB.bottom) / 2) - ((layerBound.top + layerBound.bottom) / 2));
  } catch (e) {
    console.log(e);
  }
};


  // A quick diagnostics action for user to press
  function runDiagnostics() {
    try {
      setDebugLogs([]);
      appendLog("=== Running Diagnostics ===");
      dumpLayerTree();
      dumpSelectedLayersInfo();
      appendLog("=== Diagnostics complete. Copy and paste these logs back to me ===");
      setShowLogPanel(true);
    } catch (e) {
      appendLog("runDiagnostics error", e);
    }
  }

  // UI Buttons: show logs, clear logs
  function clearLogs() {
    setDebugLogs([]);
  }

  // Render
  return React.createElement("div", { className: "photo-browser" },
    // inline alert
    alertMessage ? React.createElement("div", { className: "uxp-alert-backdrop", role: "dialog", "aria-modal": "true" },
      React.createElement("div", { className: "uxp-alert" },
        React.createElement("h3", null, alertTitle),
        React.createElement("pre", { className: "uxp-alert-message" }, alertMessage),
        React.createElement("div", { className: "uxp-alert-actions" },
          React.createElement("button", { onClick: function () { setAlertMessage(""); setAlertTitle("Notice"); } }, "OK")
        )
      )
    ) : null,

    React.createElement("div", { className: "controls" },
      React.createElement("button", { onClick: pickFolder }, "Choose folder"),
      selectedPhotos.size > 0 ? React.createElement("button", { onClick: placeSelectedIntoFrames }, "Place " + selectedPhotos.size + " selected photos") : null,
      React.createElement("button", { onClick: runDiagnostics }, "Diagnostics"),
      React.createElement("button", {
        onClick: function () {
          setShowLogPanel(!showLogPanel);
        }
      }, showLogPanel ? "Hide Logs" : "Show Logs"),
      React.createElement("div", { className: "folder-name" }, folderName)
    ),

    React.createElement("div", { className: "thumbnails" },
      photos.length === 0 ? React.createElement("div", { className: "empty" }, "No images. Choose a folder with photos.") :
        photos.map(function (item) {
          return React.createElement("div", {
            key: item.name,
            className: "thumb " + (selectedPhotos.has(item.name) ? "selected" : ""),
            onClick: function (e) { togglePhotoSelection(item, e); },
            draggable: true,
            onDragStart: function (e) { handleDragStart(e, item); }
          },
            React.createElement("img", { src: item.url, alt: item.name }),
            React.createElement("div", { className: "meta" },
              React.createElement("div", { className: "name" }, item.name)
            )
          );
        })
    ),

    // Logs panel
    showLogPanel ? React.createElement("div", { className: "debug-panel" },
      React.createElement("div", { className: "debug-controls" },
        React.createElement("button", { onClick: copyLogsToClipboard }, "Copy logs"),
        React.createElement("button", { onClick: clearLogs }, "Clear logs")
      ),
      React.createElement("pre", { className: "debug-logs", style: { maxHeight: "300px", overflow: "auto", whiteSpace: "pre-wrap" } },
        debugLogs.join("\n")
      ),
      React.createElement("div", { className: "debug-help" },
        "After reproducing the issue, click Diagnostics → Copy logs and paste them here."
      )
    ) : null
  );
} // end export

// helper: showUserAlert (unchanged)
async function showUserAlert(message, title) {
  try {
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
      return;
    }
    if (dialogs && typeof dialogs.alert === "function") {
      try {
        await dialogs.alert({ title: title, message: message });
        return;
      } catch (e) {}
    }
    if (dialogs && typeof dialogs.showAlert === "function") {
      try {
        await dialogs.showAlert(message);
        return;
      } catch (e) {}
    }
    console.warn(message);
  } catch (err) {
    console.warn("showUserAlert failed", err);
  }
}


