// PhotoBrowser.jsx — FINAL FIXED VERSION (no logs, no debug, correct mapping)
import React, { useState } from "react";
import "./PhotoBrowser.css";

var storage = require("uxp").storage;
var dialogs =
  require("uxp").dialogs ||
  (require("uxp").dialog && require("uxp").dialog);
var fs = storage.localFileSystem;
var batchPlay = require("photoshop").action.batchPlay;
var app = require("photoshop").app;

var imageExtRE = /\.(png|jpe?g|gif|webp|tif|tiff)$/i;

export default function PhotoBrowser() {
  var [photos, setPhotos] = useState([]);
  var [folderName, setFolderName] = useState("");
  var [selectedPhotos, setSelectedPhotos] = useState(new Set());
  var [alertMessage, setAlertMessage] = useState("");
  var [alertTitle, setAlertTitle] = useState("Notice");

  // --- Pick folder ---
  async function pickFolder() {
    try {
      var folder = await fs.getFolder();
      if (!folder) return;

      setFolderName(folder.name || folder.nativePath || "Selected folder");

      var entries = await folder.getEntries();
      var imageFiles = entries.filter(
        (e) => e.isFile && imageExtRE.test(e.name)
      );

      var items = await Promise.all(
        imageFiles.map(async (file) => {
          var arrayBuffer = await file.read({
            format: storage.formats.binary,
          });

          var mime = /\.png$/i.test(file.name)
            ? "image/png"
            : "image/jpeg";

          var blob = new Blob([arrayBuffer], { type: mime });
          var url = URL.createObjectURL(blob);

          return { file, url, name: file.name };
        })
      );

      setPhotos(items);
    } catch (err) {
      console.log("Folder pick error:", err);
    }
  }

  // --- Dragging ---
  function handleDragStart(e, item) {
    try {
      if (item.file.nativePath) {
        e.dataTransfer.setData("text/plain", item.file.nativePath);
      }
    } catch (err) {
      console.log("drag start:", err);
    }
  }

  // --- Selecting ---
  function togglePhotoSelection(item, event) {
    var newSelection = new Set(selectedPhotos);

    try {
      if (event.ctrlKey || event.metaKey) {
        if (newSelection.has(item.name)) newSelection.delete(item.name);
        else newSelection.add(item.name);
      } else if (event.shiftKey && selectedPhotos.size > 0) {
        var photosList = photos.map((p) => p.name);
        var lastSelected = Array.from(selectedPhotos).pop();
        var fromIndex = photosList.indexOf(lastSelected);
        var toIndex = photosList.indexOf(item.name);
        var start = Math.min(fromIndex, toIndex),
          end = Math.max(fromIndex, toIndex);

        for (var i = start; i <= end; i++)
          newSelection.add(photosList[i]);
      } else {
        newSelection.clear();
        newSelection.add(item.name);
      }

      setSelectedPhotos(newSelection);
    } catch (e) {
      console.log("togglePhotoSelection error", e);
    }
  }

  // --------------------------------------------------------------------
  //  MAIN FIXED FUNCTION: placeSelectedIntoFrames()
  // --------------------------------------------------------------------
  async function placeSelectedIntoFrames() {
    try {
      const selectedLayers = app.activeDocument.activeLayers;
      const selectedItems = photos.filter((p) =>
        selectedPhotos.has(p.name)
      );

      if (!selectedLayers || selectedLayers.length === 0)
        throw new Error("No frames selected");

      if (!selectedItems || selectedItems.length === 0)
        throw new Error("No photos selected");

      const count = Math.min(
        selectedLayers.length,
        selectedItems.length
      );

      await require("photoshop").core.executeAsModal(
        async () => {
          for (let i = 0; i < count; i++) {
            const frame = selectedLayers[i];
            const item = selectedItems[i];

            const token =
              await storage.localFileSystem.createSessionToken(
                item.file
              );

            // -------------------------------------------------
            // ❗❗ FIX: FORCE-SELECT THIS FRAME USING ITS ID
            // -------------------------------------------------
            await batchPlay(
              [
                {
                  _obj: "select",
                  _target: [{ _ref: "layer", _id: frame.id }],
                  makeVisible: false,
                },
              ],
              { synchronousExecution: true }
            );

            // 1️⃣ Place photo
            await batchPlay(
              [
                {
                  _obj: "placeEvent",
                  null: { _kind: "local", _path: token },
                  _isCommand: true,
                },
                {
                  _obj: "placedLayerConvertToSmartObject",
                  _isCommand: true,
                },
                { _obj: "commit", _isCommand: true },
              ],
              { synchronousExecution: true }
            );

            // 2️⃣ Scale & center into frame
            await resizeAlTo(frame.bounds, "fill");

            // 3️⃣ Clip the placed image to the frame
            await batchPlay(
              [
                {
                  _obj: "groupEvent",
                  _target: [
                    {
                      _enum: "ordinal",
                      _ref: "layer",
                      _value: "targetEnum",
                    },
                  ],
                },
              ],
              { synchronousExecution: true }
            );
          }
        },
        { commandName: "Place photos into frames" }
      );

      setSelectedPhotos(new Set());
    } catch (err) {
      console.error("Place error:", err);
    }
  }

  // --- Resize helper ---
  async function resizeAlTo(mLayerB, scale) {
    try {
      var doc = app.activeDocument;
      var iLayer = doc.activeLayers[0];
      var layerBound = iLayer.boundsNoEffects || iLayer.bounds;

      var scaley = mLayerB.width / layerBound.width;
      var scalex = mLayerB.height / layerBound.height;

      var scaleMax = Math.max(scaley, scalex);
      var scaleMin = Math.min(scaley, scalex);

      if (scale === "fill") scaley = scalex = scaleMax;
      else if (scale === "fit") scaley = scalex = scaleMin;

      await iLayer.scale(scaley * 100, scalex * 100);

      await iLayer.translate(
        (mLayerB.left + mLayerB.right) / 2 -
          (layerBound.left + layerBound.right) / 2,
        (mLayerB.top + mLayerB.bottom) / 2 -
          (layerBound.top + layerBound.bottom) / 2
      );
    } catch (e) {
      console.log(e);
    }
  }

  // ----------------------------------------------------------------
  //  RENDER UI  (clean — NO logs, NO diagnostics)
  // ----------------------------------------------------------------
  return (
    <div className="photo-browser">
      {alertMessage ? (
        <div className="uxp-alert-backdrop" role="dialog">
          <div className="uxp-alert">
            <h3>{alertTitle}</h3>
            <pre className="uxp-alert-message">{alertMessage}</pre>
            <div className="uxp-alert-actions">
              <button
                onClick={() => {
                  setAlertMessage("");
                  setAlertTitle("Notice");
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="controls">
        <button onClick={pickFolder}>Choose folder</button>

        {selectedPhotos.size > 0 ? (
          <button onClick={placeSelectedIntoFrames}>
            Place {selectedPhotos.size} selected photos
          </button>
        ) : null}

        <div className="folder-name">{folderName}</div>
      </div>

      <div className="thumbnails">
        {photos.length === 0 ? (
          <div className="empty">No images. Choose a folder.</div>
        ) : (
          photos.map((item) => (
            <div
              key={item.name}
              className={`thumb ${
                selectedPhotos.has(item.name) ? "selected" : ""
              }`}
              onClick={(e) => togglePhotoSelection(item, e)}
              draggable={true}
              onDragStart={(e) => handleDragStart(e, item)}
            >
              <img src={item.url} alt={item.name} />
              <div className="meta">
                <div className="name">{item.name}</div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
