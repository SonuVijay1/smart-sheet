// PhotoBrowser.jsx — Final merged file
// - Multi-tab persistent selection
// - Global selection count in Place button
// - Mark placed photos as used (badge)
// - UXP-compatible (no optional chaining)

import React, { useState, useEffect } from "react";
import "./PhotoBrowser.css";

var storage = require("uxp").storage;
var fs = storage.localFileSystem;
var batchPlay = require("photoshop").action.batchPlay;
var app = require("photoshop").app;

var imageExtRE = /\.(png|jpe?g|gif|webp|tif|tiff)$/i;

export default function PhotoBrowser() {
  // Tabs state
  const [tabs, setTabs] = useState([]); // {id, name, folderEntry, photos: [{file,url,name,used}]}
  const [activeTab, setActiveTab] = useState(null);

  // Selection per tab: { tabId: Set([photoName, ...]) }
  const [tabSelections, setTabSelections] = useState({});

  // Alerts
  const [alertMessage, setAlertMessage] = useState("");
  const [alertTitle, setAlertTitle] = useState("Notice");

  // Thumbnail / slider
  const BRIDGE_MIN = 80;
  const BRIDGE_MAX = 350;
  const BRIDGE_DEFAULT = 180;
  const TILE_ASPECT_RATIO = 0.78;

  const [tileWidth, setTileWidth] = useState(
    parseInt(window.localStorage.getItem("photoBrowser.tileWidth")) || BRIDGE_DEFAULT
  );
  const tileHeight = Math.round(tileWidth * TILE_ASPECT_RATIO);

  useEffect(() => {
    try {
      window.localStorage.setItem("photoBrowser.tileWidth", String(tileWidth));
    } catch (e) {}
  }, [tileWidth]);

  // ---------------------------
  // Helpers: load images from folder
  // ---------------------------
  async function loadImagesFromFolder(folder) {
    const entries = await folder.getEntries();
    const imageFiles = entries.filter((e) => e.isFile && imageExtRE.test(e.name));

    const items = await Promise.all(
      imageFiles.map(async (file) => {
        const arrayBuffer = await file.read({ format: storage.formats.binary });
        const mime = /\.png$/i.test(file.name) ? "image/png" : "image/jpeg";
        const blob = new Blob([arrayBuffer], { type: mime });
        const url = URL.createObjectURL(blob);
        return { file, url, name: file.name, used: false };
      })
    );
    return items;
  }

  // ---------------------------
  // Add tab from folder picker (+ button)
  // ---------------------------
  async function addTabFromPicker() {
    try {
      if (tabs.length >= 5) {
        setAlertTitle("Limit");
        setAlertMessage("Maximum tab limit exceeded");
        return;
      }
      const folder = await fs.getFolder();
      if (!folder) return;

      const photos = await loadImagesFromFolder(folder);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const name = folder.name || folder.nativePath || "Folder";

      const newTab = { id, name, folderEntry: folder, photos };
      setTabs((prev) => [...prev, newTab]);
      setActiveTab(id);
      setTabSelections((prev) => ({ ...prev, [id]: new Set() }));
    } catch (e) {
      console.log("addTabFromPicker error", e);
    }
  }

  // ---------------------------
  // Open / activate existing tab
  // ---------------------------
  async function openTab(tabId) {
    const tab = tabs.find(function (t) { return t.id === tabId; });
    if (!tab) return;

    // if photos missing, reload from entry
    if (!tab.photos || tab.photos.length === 0) {
      try {
        const photos = await loadImagesFromFolder(tab.folderEntry);
        setTabs((prev) => prev.map((p) => (p.id === tabId ? { ...p, photos } : p)));
      } catch (e) {
        console.log("openTab load error", e);
      }
    }
    setActiveTab(tabId);

    // ensure selection bucket exists
    setTabSelections((prev) => {
      if (prev[tabId]) return prev;
      return { ...prev, [tabId]: new Set() };
    });
  }

  // ---------------------------
  // Alert helpers
  // ---------------------------
  function closeAlert() {
    setAlertMessage("");
    setAlertTitle("Notice");
  }

  // ---------------------------
  // Drag start (unchanged)
  // ---------------------------
  function handleDragStart(e, item) {
    try {
      if (item.file && item.file.nativePath) {
        e.dataTransfer.setData("text/plain", item.file.nativePath);
      }
    } catch (err) {
      console.log("drag start:", err);
    }
  }

  // ---------------------------
  // Selection per-tab (no optional chaining)
  // toggleSelectPhoto(tabId, photoName, event)
  // ---------------------------
  function toggleSelectPhoto(tabId, photoName, event) {
    const t = tabs.find(function (x) { return x.id === tabId; });
    const photos = t ? t.photos : [];

    const prev = tabSelections[tabId] || new Set();
    const newSet = new Set(prev);

    try {
      if (event.ctrlKey || event.metaKey) {
        if (newSet.has(photoName)) newSet.delete(photoName);
        else newSet.add(photoName);
      } else if (event.shiftKey && newSet.size > 0) {
        // shift selection within this tab
        const names = photos.map(function (p) { return p.name; });
        const last = Array.from(newSet).pop();
        const from = names.indexOf(last);
        const to = names.indexOf(photoName);
        const start = Math.min(from, to);
        const end = Math.max(from, to);
        for (let i = start; i <= end; i++) {
          if (names[i]) newSet.add(names[i]);
        }
      } else {
        newSet.clear();
        newSet.add(photoName);
      }

      setTabSelections((prev) => ({ ...prev, [tabId]: newSet }));
    } catch (e) {
      console.log("toggleSelectPhoto error", e);
    }
  }

  // ---------------------------
  // Global selection helpers
  // ---------------------------
  function getGlobalSelectedCount() {
    let total = 0;
    for (let key in tabSelections) {
      const s = tabSelections[key];
      if (s && typeof s.size === "number") total += s.size;
    }
    return total;
  }

  function getAllSelectedPhotoObjects() {
    const result = [];
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const sel = tabSelections[tab.id] || new Set();
      for (let j = 0; j < (tab.photos || []).length; j++) {
        const ph = tab.photos[j];
        if (sel.has(ph.name)) {
          result.push({ tabId: tab.id, photo: ph });
        }
      }
    }
    return result;
  }

  // ---------------------------
  // Place Selected Photos (Option A - global)
  // Marks placed photos as used, and removes them from corresponding tabSelections
  // ---------------------------
  async function placeSelectedIntoFrames() {
    try {
      const allSelected = getAllSelectedPhotoObjects();
      if (!allSelected || allSelected.length === 0) {
        setAlertTitle("Notice");
        setAlertMessage("No photos selected");
        return;
      }

      const selectedLayers = app.activeDocument.activeLayers;
      if (!selectedLayers || selectedLayers.length === 0) {
        throw new Error("No frames selected");
      }

      // NEW VALIDATION: counts must match
      if (allSelected.length !== selectedLayers.length) {
        setAlertTitle("Selection Mismatch");
        setAlertMessage(
          "Please select the same number of photos as frames.\n" +
          "Selected photos: " + allSelected.length + "\n" +
          "Selected frames: " + selectedLayers.length
        );
        return;
    }


      // place up to min(layers, selectedPhotos)
      const count = Math.min(selectedLayers.length, allSelected.length);

      await require("photoshop").core.executeAsModal(
        async () => {
          for (let i = 0; i < count; i++) {
            const frame = selectedLayers[i];
            const entry = allSelected[i];
            const photo = entry.photo;
            const tabId = entry.tabId;

            const token = await storage.localFileSystem.createSessionToken(photo.file);

            // select the frame
            await batchPlay(
              [
                {
                  _obj: "select",
                  _target: [{ _ref: "layer", _id: frame.id }],
                },
              ],
              { synchronousExecution: true }
            );

            // place the file
            await batchPlay(
              [
                {
                  _obj: "placeEvent",
                  null: { _kind: "local", _path: token },
                },
                { _obj: "placedLayerConvertToSmartObject" },
                { _obj: "commit" },
              ],
              { synchronousExecution: true }
            );

            // scale & center
            await resizeAlTo(frame.bounds, "fill");

            // clip to frame (group)
            await batchPlay(
              [
                {
                  _obj: "groupEvent",
                  _target: [{ _enum: "ordinal", _ref: "layer", _value: "targetEnum" }],
                },
              ],
              { synchronousExecution: true }
            );

            // mark used for that photo in tabs
            setTabs((prevTabs) =>
              prevTabs.map(function (t) {
                if (t.id !== tabId) return t;
                return {
                  ...t,
                  photos: t.photos.map(function (ph) {
                    if (ph.name === photo.name) {
                      return { ...ph, used: true };
                    }
                    return ph;
                  }),
                };
              })
            );

            // remove placed photo from that tab's selection set
            setTabSelections((prevSel) => {
              const newSel = { ...prevSel };
              const s = new Set(newSel[tabId] || []);
              if (s.has(photo.name)) {
                s.delete(photo.name);
                newSel[tabId] = s;
              }
              return newSel;
            });
          }
        },
        { commandName: "Place photos into frames" }
      );
    } catch (err) {
      console.error("Place error:", err);
      setAlertTitle("Error");
      setAlertMessage(err.message || String(err));
    }
  }

  // ---------------------------
  // resize helper (unchanged)
  // ---------------------------
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
        (mLayerB.left + mLayerB.right) / 2 - (layerBound.left + layerBound.right) / 2,
        (mLayerB.top + mLayerB.bottom) / 2 - (layerBound.top + layerBound.bottom) / 2
      );
    } catch (e) {
      console.log(e);
    }
  }

  // ---------------------------
  // Inline styles for thumbs
  // ---------------------------
  function getThumbContainerStyle() {
    return {
      width: `${tileWidth}px`,
      height: `${tileHeight}px`,
      padding: "6px",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--panel)",
      border: "1px solid var(--border)",
      borderRadius: 6,
      cursor: "pointer",
      position: "relative",
    };
  }

  function getImageStyle() {
    return {
      maxWidth: "100%",
      maxHeight: "100%",
      objectFit: "contain",
      background: "#111",
      borderRadius: 4,
      display: "block",
    };
  }


  async function handleDoubleClickPlace(photo) {
  try {
    const selectedLayers = app.activeDocument.activeLayers;

    if (!selectedLayers || selectedLayers.length === 0) {
      setAlertTitle("No Frame Selected");
      setAlertMessage("Please select a single frame to place this photo.");
      return;
    }

    if (selectedLayers.length > 1) {
      setAlertTitle("Multiple Frames Selected");
      setAlertMessage("Double-click placement works only when one frame is selected.");
      return;
    }

    const frame = selectedLayers[0];
    const token = await storage.localFileSystem.createSessionToken(photo.file);

    await require("photoshop").core.executeAsModal(
      async () => {
        // select the frame
        await batchPlay(
          [
            {
              _obj: "select",
              _target: [{ _ref: "layer", _id: frame.id }],
            },
          ],
          { synchronousExecution: true }
        );

        // place the photo
        await batchPlay(
          [
            {
              _obj: "placeEvent",
              null: { _kind: "local", _path: token }
            },
            { _obj: "placedLayerConvertToSmartObject" },
            { _obj: "commit" }
          ],
          { synchronousExecution: true }
        );

        // scale and center inside the frame
        await resizeAlTo(frame.bounds, "fill");

        // clip
        await batchPlay(
          [
            {
              _obj: "groupEvent",
              _target: [
                { _enum: "ordinal", _ref: "layer", _value: "targetEnum" }
              ]
            }
          ],
          { synchronousExecution: true }
        );
      },
      { commandName: "Double-click Place Photo" }
    );

  } catch (e) {
    setAlertTitle("Error");
    setAlertMessage(e.message || String(e));
  }
}


  // ---------------------------
  // Render
  // ---------------------------
  const activeTabObj = tabs.find(function (t) { return t.id === activeTab; }) || null;

  return (
    <div className="photo-browser">
      {/* Alert */}
      {alertMessage ? (
        <div className="uxp-alert-backdrop" role="dialog">
          <div className="uxp-alert">
            <h3>{alertTitle}</h3>
            <pre className="uxp-alert-message">{alertMessage}</pre>
            <div className="uxp-alert-actions">
              <button onClick={closeAlert}>OK</button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Controls */}
      <div className="controls">
        {/* Use global selected count from all tabs */}
        {getGlobalSelectedCount() > 0 ? (
          <button onClick={placeSelectedIntoFrames}>
            Place {getGlobalSelectedCount()}
          </button>
        ) : null}

        <div className="folder-name" style={{ marginLeft: "8px" }}>
          {activeTabObj ? activeTabObj.name : "No folder opened"}
        </div>
      </div>

      {/* Tabs row */}
      <div className="tabs-row" role="tablist" aria-label="Folder tabs">
        {tabs.map(function (t) {
          return (
            <button
              key={t.id}
              className={"tab " + (t.id === activeTab ? "tab-active" : "")}
              title={t.name}
              onClick={function () { openTab(t.id); }}
            >
              <span className="tab-icon">📁</span>
              <span className="tab-letter">{t.name ? t.name.charAt(0).toUpperCase() : "?"}</span>
            </button>
          );
        })}

        {/* Add tab button */}
        <button
          className="tab add-tab"
          title="Choose folder"
          onClick={async function () {
            if (tabs.length >= 5) {
              setAlertTitle("Limit");
              setAlertMessage("Maximum tab limit exceeded");
              return;
            }
            try {
              const folder = await fs.getFolder();
              if (!folder) return;
              const photos = await loadImagesFromFolder(folder);
              const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              const name = folder.name || folder.nativePath || "Folder";
              const newTab = { id: id, name: name, folderEntry: folder, photos: photos };
              setTabs((prev) => [...prev, newTab]);
              setActiveTab(id);
              setTabSelections((prev) => ({ ...prev, [id]: new Set() }));
            } catch (e) {
              console.log("choose folder error", e);
            }
          }}
        >
          <span className="tab-icon"></span>
          <span className="tab-letter">+</span>
        </button>
      </div>

      {/* Thumbnails */}
      <div className="thumbnails" aria-live="polite">
        {activeTabObj && activeTabObj.photos && activeTabObj.photos.length > 0 ? (
          activeTabObj.photos.map(function (item) {
            // selection is per-tab
            const selSet = tabSelections[activeTab] || new Set();
            const isSelected = selSet.has(item.name);
            const usedClass = item.used ? " used" : "";

            return (
              <div
                key={activeTab + "-" + item.name}
                className={"thumb" + (isSelected ? " selected" : "") + (item.used ? " used" : "")}
                style={getThumbContainerStyle()}
                onClick={function (e) { toggleSelectPhoto(activeTab, item.name, e); }}
                onDoubleClick={() => handleDoubleClickPlace(item)}
                draggable={true}
                onDragStart={function (e) { handleDragStart(e, item); }}
              >
                <img src={item.url} alt={item.name} style={getImageStyle()} />
              </div>
            );
          })
        ) : (
          <div className="empty">No images. Use the + button to open a folder (max 5 tabs).</div>
        )}
      </div>

      {/* Always-visible minimal slider centered at bottom */}
      {activeTabObj && activeTabObj.photos && activeTabObj.photos.length > 0 ? (
      <div className="zoom-slider">
      <button className="zoom-btn" onClick={() => setTileWidth(Math.max(tileWidth - 10, BRIDGE_MIN))}>−</button>

      <input
        className="zoom-range"
        type="range"
        min={BRIDGE_MIN}
        max={BRIDGE_MAX}
        value={tileWidth}
        onChange={(e) => setTileWidth(parseInt(e.target.value))}
      />

      <button className="zoom-btn" onClick={() => setTileWidth(Math.min(tileWidth + 10, BRIDGE_MAX))}>+</button>
  </div>
) : null}

    </div>
  );
}
