import React, { useState } from "react";
import "./PhotoBrowser.css";

const { storage, dialogs } = require("uxp");
const fs = storage.localFileSystem;
const { action: { batchPlay } } = require("photoshop");
const app = require('photoshop').app;

const imageExtRE = /\.(png|jpe?g|gif|webp|tif|tiff)$/i;

async function detectFramesFromPSD() {
  const app = require("photoshop").app;
  const core = require("photoshop").core;
  const fs = require("uxp").storage.localFileSystem;

  try {
    let pngFile, docWidth, docHeight;

    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      docWidth = doc.width.value;
      docHeight = doc.height.value;
      const tempFolder = await fs.getTemporaryFolder();
      pngFile = await tempFolder.createFile("frame_preview.png", { overwrite: true });
      await doc.saveAs.png(pngFile, { quality: 10 });
      console.log("✅ Exported PSD preview:", pngFile.nativePath);
    }, { commandName: "Export PSD Preview" });

    const arrayBuffer = await pngFile.read({ format: storage.formats.binary });
    const blob = new Blob([arrayBuffer], { type: "image/png" });
    const formData = new FormData();
    formData.append("file", blob, "frame_preview.png");

    console.log("🚀 Sending to FastAPI...");
    const response = await fetch("http://127.0.0.1:8000/detect_frames", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    console.log("🧠 Detected frame boxes:", data.boxes);
    return { boxes: data.boxes || [], imageSize: data.image_size, docSize: { width: docWidth, height: docHeight } };

  } catch (err) {
    console.error("❌ detectFramesFromPSD failed:", err);
    await showUserAlert("Failed to detect frames. Check FastAPI connection.");
    return { boxes: [], imageSize: null, docSize: null };
  }
}

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

      if (selectedLayers.length === 0) {
        throw new Error("No frames selected");
      }
      if (selectedItems.length === 0) {
        throw new Error("No photos selected");
      }

      // NEW: Inform user when more images are selected than frames
      if (selectedItems.length > selectedLayers.length) {
        const msg = `You selected ${selectedItems.length} images but only ${selectedLayers.length} frame` +
                    `${selectedLayers.length === 1 ? "" : "s"} is/are selected.\n\n` +
                    `Please select at most ${selectedLayers.length} image` +
                    `${selectedLayers.length === 1 ? "" : "s"} or select more frames, then try again.`;
        // show in-panel modal and return
        setAlertTitle("Selection mismatch");
        setAlertMessage(msg);
         return; // stop processing until user corrects selection
      }

      // only place up to the number of frames to avoid overlap
      const count = Math.min(selectedLayers.length, selectedItems.length);
      if (selectedItems.length > selectedLayers.length) {
        console.warn(`More photos selected (${selectedItems.length}) than frames (${selectedLayers.length}). Only first ${count} photos will be placed.`);
      }

      console.log("placeSelectedIntoFrames START", { layers: selectedLayers.length, photos: selectedItems.length, using: count });

      await require("photoshop").core.executeAsModal(
        async () => {
          try {
            for (let i = 0; i < count; i++) {
              const frameLayer = selectedLayers[i];
              const item = selectedItems[i];
              console.log(`placing [${i}] photo="${item.name}" -> layerId=${frameLayer.id}`);

              const token = await storage.localFileSystem.createSessionToken(item.file);
              console.log("session token created");

              // select the frame layer via DOM
              try {
                app.activeDocument.activeLayers = [frameLayer];
                console.log("frame layer selected via DOM", frameLayer.id);
              } catch (selErr) {
                console.warn("DOM layer select failed, continuing", selErr);
              }

              // place image and convert to smart object
              await batchPlay(
                [
                  { _obj: "placeEvent", null: { _kind: "local", _path: token }, _isCommand: true },
                  { _obj: "placedLayerConvertToSmartObject", _isCommand: true }
                ],
                { synchronousExecution: true }
              );

              // now the placed layer is the active layer
              const placedLayer = app.activeDocument.activeLayers[0];
              console.log("placed layer:", placedLayer.id);

              // get frame bounds and placed layer bounds (use UnitValue .value)
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

              // compute scale percent to COVER the frame while preserving aspect ratio
              const scaleFactor = Math.max(frameW / placedW, frameH / placedH);
              const scalePercent = Math.round(scaleFactor * 100);

              console.log({ frameW, frameH, placedW, placedH, scaleFactor, scalePercent });

              // scale the placed layer via batchPlay (avoid placedLayer.resize which is not available)
              try {
                await batchPlay(
                  [
                    {
                      _obj: "transform",
                      _isCommand: true,
                      // explicit horizontal + vertical percent -> reliable scaling
                      scaleHorizontal: { _unit: "percentUnit", _value: scalePercent },
                      scaleVertical: { _unit: "percentUnit", _value: scalePercent },
                      freeTransformCenterState: { _ref: "null" }
                    }
                  ],
                  { synchronousExecution: true }
                );
              } catch (scaleErr) {
                console.warn("batchPlay scale failed:", scaleErr);
              }

              // center placed layer over the frame using batchPlay transform offset
              try {
                const newPb = app.activeDocument.activeLayers[0].bounds;
                const newPlacedLeft = Number(newPb.left.value || newPb.left);
                const newPlacedTop = Number(newPb.top.value || newPb.top);
                const newPlacedRight = Number(newPb.right.value || newPb.right);
                const newPlacedBottom = Number(newPb.bottom.value || newPb.bottom);
                const newPlacedW = newPlacedRight - newPlacedLeft;
                const newPlacedH = newPlacedBottom - newPlacedTop;

                const dx = frameLeft + frameW / 2 - (newPlacedLeft + newPlacedW / 2);
                const dy = frameTop + frameH / 2 - (newPlacedTop + newPlacedH / 2);

                await batchPlay(
                  [
                    {
                      _obj: "transform",
                      _isCommand: true,
                      offset: { _obj: "offset", horizontal: dx, vertical: dy }
                    }
                  ],
                  { synchronousExecution: true }
                );
              } catch (centerErr) {
                console.warn("centering placed layer failed:", centerErr);
              }

              // make clipped to the frame (frame must be above the placed layer for clipping behavior)
              try {
                // ensure frame layer is the clipping parent: select placed layer then create clipping mask
                app.activeDocument.activeLayers = [placedLayer];
                await batchPlay([{ _obj: "createClippingMask", _isCommand: true }], { synchronousExecution: true });
              } catch (clipErr) {
                console.warn("createClippingMask failed:", clipErr);
              }

              console.log(`placed [${i}] done`);
            }
          } catch (innerErr) {
            console.error("Error inside modal:", innerErr);
            throw innerErr;
          }
        },
        { commandName: "Place Multiple Into Frames" }
      );

      console.log("placeSelectedIntoFrames COMPLETE");
      setSelectedPhotos(new Set());
    } catch (err) {
      console.error("Batch place error:", err);
    }
  }

  // ====================== AUTO PLACE PHOTOS WITH AI ======================
async function autoPlacePhotosWithAI() {
  console.log("🧠 AI button clicked!");
  const core = require("photoshop").core;

  try {
    const { boxes, imageSize, docSize } = await detectFramesFromPSD();
    if (!boxes.length) {
      await showUserAlert("No frames detected by AI.");
      return;
    }

    const selectedItems = photos.filter((item) => selectedPhotos.has(item.name));
    if (!selectedItems.length) {
      await showUserAlert("No photos selected.");
      return;
    }

    // Map coordinates from exported PNG → actual PSD size
    const scaleX = docSize.width / imageSize.width;
    const scaleY = docSize.height / imageSize.height;
    console.log("📐 Mapping scale:", { scaleX, scaleY });

    const count = Math.min(boxes.length, selectedItems.length);

    for (let i = 0; i < count; i++) {
      const frame = boxes[i];
      const photo = selectedItems[i];

      const scaledFrame = {
        left: frame.x * scaleX,
        top: frame.y * scaleY,
        right: (frame.x + frame.w) * scaleX,
        bottom: (frame.y + frame.h) * scaleY,
      };

      const formData = new FormData();
      formData.append(
        "frame_box",
        JSON.stringify({
          x: scaledFrame.left,
          y: scaledFrame.top,
          w: scaledFrame.right - scaledFrame.left,
          h: scaledFrame.bottom - scaledFrame.top,
        })
      );

      const arrayBuffer = await photo.file.read({
        format: storage.formats.binary,
      });
      const blob = new Blob([arrayBuffer], { type: "image/jpeg" });
      formData.append("photo", blob, photo.name);

      console.log(`🧠 Sending ${photo.name} to /fit_photo`);
      const response = await fetch("http://127.0.0.1:8000/fit_photo", {
        method: "POST",
        body: formData,
      });
      const result = await response.json();

      if (!result.target_box) {
        console.warn("⚠️ AI did not return valid box:", result);
        continue;
      }

      result.photoFile = photo.file;
      console.log("📦 AI transform result:", result);

      // 🧩 Run all Photoshop edits inside one modal
      await core.executeAsModal(
        async () => {
          await applyTransform(result);
        },
        { commandName: "AI Place with Clipping Mask" }
      );
    }

    await showUserAlert("✅ AI fitted photos into frames precisely!");
  } catch (err) {
    console.error("AI placement error:", err);
    await showUserAlert("Error during AI placement: " + err.message);
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

  {/* 👇 New AI button */}
  <button className="ai-detect" onClick={autoPlacePhotosWithAI}>
    🧠 AI Detect & Auto-Fill
  </button>

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

// ====================== APPLY TRANSFORM ======================
async function applyTransform(result) {
  const { batchPlay } = require("photoshop").action;
  const app = require("photoshop").app;
  const storage = require("uxp").storage;

  try {
    if (!result || !result.target_box) {
      console.error("⚠️ Invalid AI result:", result);
      return;
    }

    const { left, top, right, bottom } = result.target_box;
    const photoFile = result.photoFile;
    if (!photoFile) {
      console.error("⚠️ Missing photo file reference");
      return;
    }

    // Create session token for photo
    const token = await storage.localFileSystem.createSessionToken(photoFile);

    // Step 1️⃣ Place image
    await batchPlay(
      [
        {
          _obj: "placeEvent",
          null: { _path: token, _kind: "local" },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: true }
    );

    // Step 2️⃣ Transform image to fit frame
    const width = right - left;
    const height = bottom - top;
    await batchPlay(
      [
        {
          _obj: "transform",
          _isCommand: true,
          freeTransformCenterState: {
            _enum: "quadCenterState",
            _value: "QCSCorner0",
          },
          offset: {
            _obj: "offset",
            horizontal: { _unit: "pixelsUnit", _value: left },
            vertical: { _unit: "pixelsUnit", _value: top },
          },
          width: { _unit: "pixelsUnit", _value: width },
          height: { _unit: "pixelsUnit", _value: height },
          _options: { dialogOptions: "dontDisplay" },
        },
      ],
      { synchronousExecution: true }
    );

    console.log("📏 Transformed photo:", { left, top, width, height });

    // Step 3️⃣ Clip image to frame below
    try {
      await batchPlay(
        [
          {
            _obj: "createClippingMask",
            _options: { dialogOptions: "dontDisplay" },
          },
        ],
        { synchronousExecution: true }
      );
      console.log("✅ Clipping mask applied");
    } catch (clipErr) {
      console.warn("⚠️ Could not create clipping mask:", clipErr);
    }

    console.log("✅ Photo fitted inside frame successfully");
  } catch (err) {
    console.error("❌ applyTransform failed:", err);
  }
}

