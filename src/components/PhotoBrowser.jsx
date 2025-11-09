import React, { useState } from "react";
import "./PhotoBrowser.css";

const { storage, dialogs } = require("uxp");
const fs = storage.localFileSystem;
const { action: { batchPlay } } = require("photoshop");
const app = require('photoshop').app;

const imageExtRE = /\.(png|jpe?g|gif|webp|tif|tiff)$/i;

export default function PhotoBrowser() {
  const [photos, setPhotos] = useState([]);
  const [folderName, setFolderName] = useState("");
  const [selectedPhotos, setSelectedPhotos] = useState(new Set());
  const [alertMessage, setAlertMessage] = useState(""); // <-- added
  const [alertTitle, setAlertTitle] = useState("Notice"); // <-- optional title

  async function pickFolder() {
    try {
      const folder = await fs.getFolder();
      if (!folder) return;

      setFolderName(folder.name || folder.nativePath || "Selected folder");
      const entries = await folder.getEntries();
      const imageFiles = entries.filter((e) => e.isFile && imageExtRE.test(e.name));

      const items = await Promise.all(
        imageFiles.map(async (file) => {
          const arrayBuffer = await file.read({ format: storage.formats.binary });
          const mime = /\.png$/i.test(file.name) ? "image/png" : "image/jpeg";
          const blob = new Blob([arrayBuffer], { type: mime });
          const url = URL.createObjectURL(blob);
          return { file, url, name: file.name };
        })
      );

      setPhotos(items);
    } catch (err) {
      console.error("Folder pick error:", err);
    }
  }

  function handleDragStart(e, item) {
    try {
      if (item.file.nativePath) {
        e.dataTransfer.setData("text/plain", item.file.nativePath);
      }
    } catch (err) {
      console.warn("drag start:", err);
    }
  }

  function togglePhotoSelection(item, event) {
    const newSelection = new Set(selectedPhotos);
    if (event.ctrlKey || event.metaKey) {
      if (newSelection.has(item.name)) {
        newSelection.delete(item.name);
      } else {
        newSelection.add(item.name);
      }
    } else if (event.shiftKey && selectedPhotos.size > 0) {
      const photosList = photos.map(p => p.name);
      const lastSelected = Array.from(selectedPhotos).pop();
      const fromIndex = photosList.indexOf(lastSelected);
      const toIndex = photosList.indexOf(item.name);
      const [start, end] = [Math.min(fromIndex, toIndex), Math.max(fromIndex, toIndex)];
      
      for (let i = start; i <= end; i++) {
        newSelection.add(photosList[i]);
      }
    } else {
      newSelection.clear();
      newSelection.add(item.name);
    }
    setSelectedPhotos(newSelection);
  }

  async function placeIntoDocument(item) {
    try {
      const token = await storage.localFileSystem.createSessionToken(item.file);
      
      await require('photoshop').core.executeAsModal(async () => {
        const activeLayer = app.activeDocument.activeLayers[0];
        if (!activeLayer) {
          throw new Error("No layer selected");
        }

        const result = await batchPlay(
          [
            {
              _obj: "placeEvent",
              target: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" },
              null: {
                _kind: "local",
                _path: token
              },
              _isCommand: true
            }
          ],
          {
            synchronousExecution: true
          }
        );

        const placedLayer = app.activeDocument.activeLayers[0];
        
        await batchPlay(
          [
            {
              _obj: "placedLayerConvertToSmartObject",
              _isCommand: true,
              _target: { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
            }
          ],
          { synchronousExecution: true }
        );

        await batchPlay(
          [
            {
              _obj: "transform",
              _isCommand: true,
              bounds: activeLayer.bounds,
              width: activeLayer.bounds.width,
              height: activeLayer.bounds.height,
              linked: true,
              relative: true
            }
          ],
          { synchronousExecution: true }
        );

        await batchPlay(
          [
            {
              _obj: "createClippingMask",
              _isCommand: true
            }
          ],
          { synchronousExecution: true }
        );
      }, {
        commandName: 'Place Into Frame'
      });
    } catch (err) {
      console.error("Place error:", err, "for file:", item.file.nativePath);
    }
  }

  async function placeSelectedIntoFrames() {
  try {
    const selectedLayers = app.activeDocument.activeLayers;
    const selectedItems = photos.filter((item) => selectedPhotos.has(item.name));

    if (selectedLayers.length === 0) throw new Error("No frames selected");
    if (selectedItems.length === 0) throw new Error("No photos selected");

    if (selectedItems.length > selectedLayers.length) {
      const msg = `You selected ${selectedItems.length} images but only ${selectedLayers.length} frame${selectedLayers.length === 1 ? "" : "s"}.\n\nSelect up to ${selectedLayers.length} image${selectedLayers.length === 1 ? "" : "s"}.`;
      setAlertTitle("Selection mismatch");
      setAlertMessage(msg);
      return;
    }

    const count = Math.min(selectedLayers.length, selectedItems.length);

    console.log("placeSelectedIntoFrames START", { layers: selectedLayers.length, photos: selectedItems.length, using: count });

    await require("photoshop").core.executeAsModal(async () => {
      for (let i = 0; i < count; i++) {
        const frameLayer = selectedLayers[i];
        const item = selectedItems[i];
        console.log(`Placing [${i}] photo="${item.name}" -> layerId=${frameLayer.id}`);

        const token = await storage.localFileSystem.createSessionToken(item.file);
        app.activeDocument.activeLayers = [frameLayer];

        // 1️⃣ Place and convert to Smart Object
        await batchPlay([
          { _obj: "placeEvent", null: { _kind: "local", _path: token }, _isCommand: true },
          { _obj: "placedLayerConvertToSmartObject", _isCommand: true }
        ], { synchronousExecution: true });

        // 2️⃣ Commit placement
        await batchPlay([{ _obj: "commit", _isCommand: true }], { synchronousExecution: true });

        // 3️⃣ Get placed + frame bounds
        let placedLayer = app.activeDocument.activeLayers[0];
        const fb = frameLayer.bounds;
        const pb = placedLayer.bounds;

        const frameLeft = Number(fb.left.value || fb.left);
        const frameTop = Number(fb.top.value || fb.top);
        const frameRight = Number(fb.right.value || fb.right);
        const frameBottom = Number(fb.bottom.value || fb.bottom);
        const frameW = frameRight - frameLeft;
        const frameH = frameBottom - frameTop;

        const placedLeft = Number(pb.left.value || pb.left);
        const placedTop = Number(pb.top.value || pb.top);
        const placedRight = Number(pb.right.value || pb.right);
        const placedBottom = Number(pb.bottom.value || pb.bottom);
        const placedW = placedRight - placedLeft;
        const placedH = placedBottom - placedTop;

        // 4️⃣ Contain scale
        const scaleFactor = Math.min(frameW / placedW, frameH / placedH);
        const scalePercent = scaleFactor * 100;

        console.log("before scale:", { frameW, frameH, placedW, placedH, scaleFactor });

        // 5️⃣ Scale and center
        const frameCenterX = frameLeft + frameW / 2;
        const frameCenterY = frameTop + frameH / 2;
        const placedCenterX = placedLeft + placedW / 2;
        const placedCenterY = placedTop + placedH / 2;
        const dx = frameCenterX - placedCenterX;
        const dy = frameCenterY - placedCenterY;

        await batchPlay([
          {
            _obj: "transform",
            _isCommand: true,
            freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
            scaleHorizontal: { _unit: "percentUnit", _value: scalePercent },
            scaleVertical: { _unit: "percentUnit", _value: scalePercent },
            offset: {
              _obj: "offset",
              horizontal: { _unit: "pixelsUnit", _value: dx },
              vertical: { _unit: "pixelsUnit", _value: dy }
            },
            linked: true
          }
        ], { synchronousExecution: true });

        // 6️⃣ Move placed layer above frame layer
        await batchPlay([
          {
            _obj: "move",
            _isCommand: true,
            _target: [{ _ref: "layer", _id: placedLayer.id }],
            to: { _ref: "layer", _id: frameLayer.id },
            adjustment: true // ensures "above" placement
          }
        ], { synchronousExecution: true });

        // 7️⃣ Clip inside frame
        app.activeDocument.activeLayers = [placedLayer];
        await batchPlay([{ _obj: "createClippingMask", _isCommand: true }], { synchronousExecution: true });

        console.log(`✅ placed [${i}] done`);
      }
    }, { commandName: "Place Multiple Into Frames" });

    console.log("placeSelectedIntoFrames COMPLETE");
    setSelectedPhotos(new Set());
  } catch (err) {
    console.error("Batch place error:", err);
  }
}

  return (
    <div className="photo-browser">
      {alertMessage && (
        <div className="uxp-alert-backdrop" role="dialog" aria-modal="true">
          <div className="uxp-alert">
            <h3>{alertTitle}</h3>
            <pre className="uxp-alert-message">{alertMessage}</pre>
            <div className="uxp-alert-actions">
              <button onClick={() => { setAlertMessage(""); setAlertTitle("Notice"); }}>OK</button>
            </div>
          </div>
        </div>
      )}

      <div className="controls">
        <button onClick={pickFolder}>Choose folder</button>
        {selectedPhotos.size > 0 && (
          <button onClick={placeSelectedIntoFrames}>
            Place {selectedPhotos.size} selected photos
          </button>
        )}
        <div className="folder-name">{folderName}</div>
      </div>

      <div className="thumbnails">
        {photos.length === 0 ? (
          <div className="empty">No images. Choose a folder with photos.</div>
        ) : (
          photos.map((item) => (
            <div
              key={item.name}
              className={`thumb ${selectedPhotos.has(item.name) ? 'selected' : ''}`}
              onClick={(e) => togglePhotoSelection(item, e)}
              draggable
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

// add helper near top of the module (after other requires)
async function showUserAlert(message, title = "Notice") {
  try {
    // browser-like alert (will be undefined in UXP usually)
    if (typeof window !== "undefined" && typeof window.alert === "function") {
      window.alert(message);
      return;
    }

    // UXP dialogs API (best-effort)
    if (dialogs && typeof dialogs.alert === "function") {
      // some UXP versions accept an options object
      try {
        await dialogs.alert({ title, message });
        return;
      } catch (e) {
        // try alternate signature
      }
    }
    if (dialogs && typeof dialogs.showAlert === "function") {
      try {
        await dialogs.showAlert(message);
        return;
      } catch (e) {}
    }

    // fallback: log and (optional) show an inline message in the panel
    console.warn(message);
  } catch (err) {
    console.warn("showUserAlert failed", err);
  }
}