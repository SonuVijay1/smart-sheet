const globalThumbnailCache = {};
const globalTabPhotos = {};

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
  const thumbRef = React.useRef(null);
  const [stats, setStats] = useState({ totalThumbs: 0, selectedCount: 0, mb: "0.00" });
  const [thumbnailsOnly, setThumbnailsOnly] = useState(true);
  const [folderCounts, setFolderCounts] = useState({});
  const [showWebMenu, setShowWebMenu] = useState(false);
  const [contextMenu, setContextMenu] = useState({
  visible: false,
  x: 0,
  y: 0,
  photo: null
});

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
  async function loadImagesFromFolder(folderEntry, oldMap = {}) {
  const entries = await folderEntry.getEntries();
  const imageEntries = entries.filter(e => /\.(jpg|jpeg|png)$/i.test(e.name));

  const photos = [];

  for (let entry of imageEntries) {
    const key = folderEntry.nativePath + "/" + entry.name;

    let old = oldMap[entry.name] || {};

    // Reuse cached URL
    if (globalThumbnailCache[key]) {
      photos.push({
        name: entry.name,
        file: entry,
        url: globalThumbnailCache[key],
        used: old.used || false,
        layerId: old.layerId || null
      });
      continue;
    }

    // Read file and cache URL
    const bin = await entry.read({ format: storage.formats.binary });
    const blob = new Blob([bin], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);

    globalThumbnailCache[key] = url;

    photos.push({
      name: entry.name,
      file: entry,
      url,
      used: old.used || false,
      layerId: old.layerId || null
    });
  }

  globalTabPhotos[folderEntry.nativePath] = photos;
  return photos;
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

  useEffect(() => {
  if (!activeTab) return;

  const tab = tabs.find(t => t.id === activeTab);
  if (tab && tab.photos) {
    setFolderCounts(prev => ({
      ...prev,
      [activeTab]: tab.photos.length
    }));
  }
}, [activeTab]);


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

            // ⭐ RASTERIZE BEFORE CLIPPING
await batchPlay(
  [
    {
      _obj: "rasterizeLayer",
      _target: [{ _ref: "layer", _id: app.activeDocument.activeLayers[0].id }],
      rasterize: { _enum: "rasterizeItem", _value: "layer" }
    }
  ],
  { synchronousExecution: true }
);

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

            // get placed layerId
            const placedLayer = app.activeDocument.activeLayers[0];
            photo.layerId = placedLayer.id;

            // mark used for that photo in tabs
            setTabs((prevTabs) =>
              prevTabs.map(function (t) {
                if (t.id !== tabId) return t;
                return {
                  ...t,
                  photos: t.photos.map(function (ph) {
                    if (ph.name === photo.name) {
                        return { ...ph, used: true, layerId: photo.layerId };
                    }
                    return ph;
                  }),
                };
              })
            );

            // ALSO update globalTabPhotos cache so UI reflects the used flag
            const folderPath = activeTabObj.folderEntry.nativePath;
              if (globalTabPhotos[folderPath]) {
                globalTabPhotos[folderPath] = globalTabPhotos[folderPath].map(ph =>
  ph.name === photo.name
    ? { ...ph, used: true, layerId: photo.layerId }
    : ph
);

              }


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

  async function refreshTab(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.folderEntry) return;

  try {
    const oldMap = {};
    tab.photos.forEach(p => {
      oldMap[p.name] = { used: p.used, layerId: p.layerId };
    });

    const photos = await loadImagesFromFolder(tab.folderEntry, oldMap);

    setTabs(prev =>
      prev.map(t =>
        t.id === tabId ? { ...t, photos } : t
      )
    );

    // Keep only photos that still exist
    setTabSelections(prev => {
      const newSet = new Set();
      const sel = prev[tabId] || new Set();
      photos.forEach(p => { if (sel.has(p.name)) newSet.add(p.name); });
      return { ...prev, [tabId]: newSet };
    });

  } catch (e) {
    console.log("Refresh error:", e);
  }
}

  async function checkFolderChange(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.folderEntry) return;

  try {
    const entries = await tab.folderEntry.getEntries();
    const count = entries.filter(e => /\.(jpg|jpeg|png)$/i.test(e.name)).length;

    const prevCount = folderCounts[tabId];

    // First activation of this tab — set count, DO NOT trigger reload
    if (prevCount === undefined) {
      setFolderCounts(prev => ({ ...prev, [tabId]: count }));
      return;
    }

    // Only refresh if true change detected
    if (count !== prevCount) {
      console.log("Change detected in tab:", tabId);

      await refreshTab(tabId);

      setFolderCounts(prev => ({ ...prev, [tabId]: count }));
    }

  } catch (err) {
    console.log("Auto-refresh error:", err);
  }
}


useEffect(() => {
  const interval = setInterval(() => {
    if (activeTab) checkFolderChange(activeTab);
  }, 4000); // check every 4 seconds

  return () => clearInterval(interval);
}, [activeTab, tabs]);


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

  async function syncUsedFlagsWithDocument() {
  try {
    const doc = app.activeDocument;
    if (!doc) return;

    // ⭐ Simply reading layer structure forces PS to update layer tree
    const existingLayerIds = [];

    function scanLayers(layerCollection) {
      for (const layer of layerCollection) {
        existingLayerIds.push(layer.id);
        if (layer.layers && layer.layers.length > 0) {
          scanLayers(layer.layers);
        }
      }
    }

    scanLayers(doc.layers);

    // Update React state
    setTabs(prev =>
      prev.map(tab => {
        const updatedPhotos = tab.photos.map(p => {
          if (!p.used || !p.layerId) return p;
          return {
            ...p,
            used: existingLayerIds.includes(p.layerId)
          };
        });
        return { ...tab, photos: updatedPhotos };
      })
    );

    // Update global cache too
    Object.keys(globalTabPhotos).forEach(path => {
      globalTabPhotos[path] = globalTabPhotos[path].map(p => {
        if (!p.used || !p.layerId) return p;
        return {
          ...p,
          used: existingLayerIds.includes(p.layerId)
        };
      });
    });

  } catch (err) {
    console.log("syncUsedFlagsWithDocument error:", err);
  }
}

async function forceLayerTreeRefresh() {
  try {
    await require("photoshop").core.executeAsModal(
      async () => {
        await batchPlay(
          [
            {
              _obj: "select",
              _target: [
                { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }
              ]
            }
          ],
          { synchronousExecution: true }
        );
      },
      { commandName: "Refresh Layer Tree" }
    );
  } catch (e) {
    console.log("layerTreeRefresh error", e);
  }
}



useEffect(() => {
  const id = setInterval(() => {
    syncUsedFlagsWithDocument();
  }, 2000); // every 2 seconds

  return () => clearInterval(id);
}, []);

useEffect(() => {
  syncUsedFlagsWithDocument();
}, [activeTab]);


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

// ⭐ RASTERIZE BEFORE CLIPPING
await batchPlay(
  [
    {
      _obj: "rasterizeLayer",
      _target: [{ _ref: "layer", _id: app.activeDocument.activeLayers[0].id }],
      rasterize: { _enum: "rasterizeItem", _value: "layer" }
    }
  ],
  { synchronousExecution: true }
);

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
        const placedLayer = app.activeDocument.activeLayers[0];
        photo.layerId = placedLayer.id;
      },
      { commandName: "Double-click Place Photo" }
    );

    //---------------------------------------------------------
// AFTER placing the photo, mark as used (LOCAL + GLOBAL)
//---------------------------------------------------------

// 1. Mark as used inside the tabs state
setTabs(prev =>
  prev.map(t =>
    t.id === activeTab
      ? {
          ...t,
          photos: t.photos.map(ph =>
            ph.name === photo.name ? { ...ph, used: true } : ph
          )
        }
      : t
  )
);

// 2. Mark as used inside the globalTabPhotos cache
if (activeTabObj && activeTabObj.folderEntry) {
  const folderPath = activeTabObj.folderEntry.nativePath;

  if (globalTabPhotos[folderPath]) {
    globalTabPhotos[folderPath] = globalTabPhotos[folderPath].map(ph =>
  ph.name === photo.name
    ? { ...ph, used: true, layerId: photo.layerId }
    : ph
);
  }
}

// 3. Remove from selection set (optional but recommended)
setTabSelections(prev => {
  const copy = { ...prev };
  const s = new Set(copy[activeTab] || []);
  if (s.has(photo.name)) {
    s.delete(photo.name);
    copy[activeTab] = s;
  }
  return copy;
});


  } catch (e) {
    setAlertTitle("Error");
    setAlertMessage(e.message || String(e));
  }
}


async function getSelectedStats() {
  if (!activeTabObj || !activeTabObj.photos) {
    return { totalThumbs: 0, selectedCount: 0, mb: "0.00" };
  }

  const totalThumbs = activeTabObj.photos.length;
  const sel = tabSelections[activeTab] || new Set();

  let totalBytes = 0;

  for (let i = 0; i < activeTabObj.photos.length; i++) {
    const p = activeTabObj.photos[i];
    if (sel.has(p.name)) {
      totalBytes += await getFileSizeInBytes(p.file);
    }
  }

  return {
    totalThumbs: totalThumbs,
    selectedCount: sel.size,
    mb: (totalBytes / (1024 * 1024)).toFixed(2)
  };
}


async function getFileSizeInBytes(fileEntry) {
  try {
    const ab = await fileEntry.read({ format: storage.formats.binary });
    return ab.byteLength;
  } catch (e) {
    return 0;
  }
}

useEffect(() => {
  async function update() {
    const s = await getSelectedStats();
    setStats(s);
  }
  update();
}, [activeTab, tabSelections]);



async function refreshFolder(tabId) {
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.folderEntry) return;

  try {
    const oldMap = {};
    tab.photos.forEach(p => {
      oldMap[p.name] = { used: p.used, layerId: p.layerId };
    });

    const photos = await loadImagesFromFolder(tab.folderEntry, oldMap);

    setTabs(prev =>
      prev.map(t =>
        t.id === tabId ? { ...t, photos } : t
      )
    );

    // keep selection if photo still exists
    setTabSelections(prev => {
      const kept = new Set();
      const sel = prev[tabId] || new Set();
      photos.forEach(p => { if (sel.has(p.name)) kept.add(p.name); });
      return { ...prev, [tabId]: kept };
    });

  } catch (e) {
    console.log("refreshFolder error:", e);
  }
}

function closeTab(tabId) {
  setTabs(function (prev) {
    const remaining = prev.filter((t) => t.id !== tabId);

    if (tabId === activeTab) {
      if (remaining.length > 0) setActiveTab(remaining[0].id);
      else setActiveTab(null);
    }

    return remaining;
  });

  setTabSelections(function (prev) {
    const copy = { ...prev };
    delete copy[tabId];
    return copy;
  });
}



  // ---------------------------
  // Render
  // ---------------------------
  const activeTabObj = tabs.find(function (t) { return t.id === activeTab; }) || null;
  let photos = activeTabObj
  ? globalTabPhotos[activeTabObj.folderEntry.nativePath] || activeTabObj.photos || []
  : [];

// Sort: unused first, used at the end
photos = [...photos].sort((a, b) => {
  if (a.used && !b.used) return 1;
  if (!a.used && b.used) return -1;
  return a.name.localeCompare(b.name); // alphabetical inside groups
});

useEffect(() => {
  function handleKey(e) {
    if (!activeTab) return;
    if (!photos || photos.length === 0) return;

    const sel = tabSelections[activeTab] || new Set();
    if (sel.size === 0) return;

    const names = photos.map(p => p.name);
    const selected = names.filter(n => sel.has(n));
    const anchor = selected[selected.length - 1];
    const idx = names.indexOf(anchor);
    let newIndex = idx;

    // ---------- GRID COLUMN CALCULATION ----------
    let columns = 1;
    if (thumbRef.current) {
      const gridWidth = thumbRef.current.clientWidth;
      columns = Math.max(1, Math.floor(gridWidth / tileWidth));
    }

    // =====================================================
    // SHIFT + RIGHT  (toggle select forward)
    // =====================================================
    if (e.shiftKey && e.key === "ArrowRight") {
      newIndex = idx + 1;
      if (newIndex >= names.length) return;

      const target = names[newIndex];
      const newSet = new Set(sel);

      // toggle
      if (newSet.has(target)) newSet.delete(target);
      else newSet.add(target);

      setTabSelections(prev => ({
        ...prev,
        [activeTab]: newSet
      }));
      e.preventDefault();
      return;
    }

    // =====================================================
    // SHIFT + LEFT  (toggle deselect backward)
    // =====================================================
    if (e.shiftKey && e.key === "ArrowLeft") {
      newIndex = idx - 1;
      if (newIndex < 0) return;

      const target = names[newIndex];
      const newSet = new Set(sel);

      // toggle
      if (newSet.has(target)) newSet.delete(target);
      else newSet.add(target);

      setTabSelections(prev => ({
        ...prev,
        [activeTab]: newSet
      }));
      e.preventDefault();
      return;
    }


    // =====================================================
    // SHIFT + DOWN (toggle down one row)
    // =====================================================
    if (e.shiftKey && e.key === "ArrowDown") {
      newIndex = idx + columns;
      if (newIndex >= names.length) return;

      const target = names[newIndex];
      const newSet = new Set(sel);

      // toggle
      if (newSet.has(target)) newSet.delete(target);
      else newSet.add(target);

      setTabSelections(prev => ({
        ...prev,
        [activeTab]: newSet
      }));
      e.preventDefault();
      return;
    }

    // =====================================================
    // SHIFT + UP (toggle up one row)
    // =====================================================
    if (e.shiftKey && e.key === "ArrowUp") {
      newIndex = idx - columns;
      if (newIndex < 0) return;

      const target = names[newIndex];
      const newSet = new Set(sel);

      // toggle
      if (newSet.has(target)) newSet.delete(target);
      else newSet.add(target);

      setTabSelections(prev => ({
        ...prev,
        [activeTab]: newSet
      }));
      e.preventDefault();
      return;
    }


    // =====================================================
    // NORMAL ARROWS — UNC HANGED
    // =====================================================
    if (e.key === "ArrowRight") newIndex = idx + 1;
    if (e.key === "ArrowLeft") newIndex = idx - 1;
    if (e.key === "ArrowDown") newIndex = idx + columns;
    if (e.key === "ArrowUp") newIndex = idx - columns;

    if (newIndex < 0 || newIndex >= names.length) return;

    const targetName = names[newIndex];
    const newSet = new Set(sel);

    // normal arrow: move selection, not toggle
    newSet.clear();
    newSet.add(targetName);

    setTabSelections(prev => ({
      ...prev,
      [activeTab]: newSet
    }));

    e.preventDefault();
  }

  window.addEventListener("keydown", handleKey);
  return () => window.removeEventListener("keydown", handleKey);
}, [activeTab, photos, tabSelections]);


function openWebBrowser() {
  require("uxp").shell.openExternal("https://google.com");
}

function handleRightClick(e, photo) {
  e.preventDefault();

  setContextMenu({
    visible: true,
    x: e.clientX,
    y: e.clientY,
    photo
  });
}

function closeContextMenu() {
  setContextMenu({ visible: false, x: 0, y: 0, photo: null });
}

async function preview(photo) {
  const nativePath = photo.file.nativePath;
  require("uxp").shell.openPath(nativePath);
  closeContextMenu();
}

function removePhoto(photo) {
  setTabs(prev =>
    prev.map(tab =>
      tab.id === activeTab
        ? { ...tab, photos: tab.photos.filter(p => p.name !== photo.name) }
        : tab
    )
  );
  closeContextMenu();
}


  return (
    <div
    className="photo-browser"
    tabIndex={0}
    onClick={(e) => { closeContextMenu(); e.currentTarget.focus(); }}
  >
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
    <div
      key={t.id}
      className={"tab " + (t.id === activeTab ? "tab-active" : "")}
      title={t.name}
      onClick={function () { openTab(t.id); }}
    >
      <span className="tab-icon">📁</span>
      <span className="tab-letter">
        {t.name ? t.name.charAt(0).toUpperCase() : "?"}
      </span>

      {/* CLOSE BUTTON */}
      <span
        className="tab-close"
        title="Close"
        onClick={function (e) {
          e.stopPropagation();
          closeTab(t.id);
        }}
      >
        ✕
      </span>
    </div>
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
      <div className="thumbnails" aria-live="polite" ref={thumbRef}>
        {photos.length > 0 ? (
            photos.map(function (item) {
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
                onContextMenu={(e) => handleRightClick(e, item)}
                draggable={true}
                onDragStart={function (e) { handleDragStart(e, item); }}
              >
                <img src={item.url} alt={item.name} style={getImageStyle()} />
                {!thumbnailsOnly ? (
                  <div className="thumb-label">{item.name}</div>
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="empty">No images. Use the + button to open a folder (max 5 tabs).</div>
        )}
      </div>

      {contextMenu.visible && (
  <div
    className="context-menu"
    style={{ top: contextMenu.y, left: contextMenu.x }}
    onClick={(e) => e.stopPropagation()}
  >
    <div className="context-item" onClick={() => removePhoto(contextMenu.photo)}>
      🗑 Delete
    </div>
    <div className="context-item" onClick={() => preview(contextMenu.photo)}>
      📂 Preview
    </div>
  </div>
)}

      {/* BOTTOM BAR — Bridge Style */}
      {activeTabObj && activeTabObj.photos && activeTabObj.photos.length > 0 ? (
  <div className="bottom-bar">
    <div className="bottom-left">
      <button
        className="zoom-btn"
        title="Decrease"
        onClick={() => setTileWidth(w => Math.max(w - 10, BRIDGE_MIN))}
      >
        −
      </button>

      <input
        className="zoom-range"
        type="range"
        min={BRIDGE_MIN}
        max={BRIDGE_MAX}
        value={tileWidth}
        onChange={e => setTileWidth(parseInt(e.target.value))}
      />

      <button
        className="zoom-btn"
        title="Increase"
        onClick={() => setTileWidth(w => Math.min(w + 10, BRIDGE_MAX))}
      >
        +
      </button>

      <div className="bottom-stats">
        {stats.totalThumbs} thumbnails, {stats.selectedCount} selected – {stats.mb} MB
      </div>
    </div>

    <div className="bottom-right">

  {/* REFRESH BUTTON */}

<button className="refresh-btn" onClick={() => refreshFolder(activeTab)} title="Refresh">
  ↻
</button>


  {/* GLOBE BUTTON */}
  {/* <div className="globe-menu-wrapper">
    <button
      className="globe-btn"
      title="Browse Internet"
      onClick={() => setShowWebMenu(prev => !prev)}
    >
      🌐
    </button>
    {showWebMenu && (
      <div className="globe-menu">
        <div className="globe-menu-item" onClick={() => { setBrowserUrl("https://google.com"); setShowBrowser(true); setShowWebMenu(false); }}>Open in Plugin</div>
        <div className="globe-menu-item" onClick={() => { require("uxp").shell.openExternal("https://google.com"); setShowWebMenu(false); }}>Open in Default Browser</div>
      </div>
    )}
  </div> */}

  {/* THUMBNAILS ONLY */}
  <label className="thumbnails-label">
    <input type="checkbox" checked={thumbnailsOnly} onChange={(e) => setThumbnailsOnly(e.target.checked)} />
    Thumbnails Only
  </label>

</div>
  </div>
) : null}


    </div>
  );
}
