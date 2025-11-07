import React, { useState } from "react";
import "./PhotoBrowser.css";

// Fix imports for UXP filesystem
const { storage } = require("uxp");
const fs = storage.localFileSystem;

const imageExtRE = /\.(png|jpe?g|gif|webp|tif|tiff)$/i;

export default function PhotoBrowser() {
  const [photos, setPhotos] = useState([]);
  const [folderName, setFolderName] = useState("");

  async function pickFolder() {
    try {
      // Use fs.getFolder() instead of localFileSystem.getFolder()
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
      // Set native path so Photoshop can accept drop
      if (item.file.nativePath) {
        e.dataTransfer.setData("text/plain", item.file.nativePath);
      }
    } catch (err) {
      console.warn("drag start:", err);
    }
  }

  async function placeIntoDocument(item) {
    try {
      await batchPlay(
        [
          {
            _obj: "placeEvent",
            null: { _path: item.file.nativePath, _kind: "local" },
          },
        ],
        {}
      );
    } catch (err) {
      console.error("Place error:", err);
    }
  }

  return (
    <div className="photo-browser">
      <div className="controls">
        <button onClick={pickFolder}>Choose folder</button>
        <div className="folder-name">{folderName}</div>
      </div>

      <div className="thumbnails">
        {photos.length === 0 ? (
          <div className="empty">No images. Choose a folder with photos.</div>
        ) : (
          photos.map((item) => (
            <div
              key={item.name}
              className="thumb"
              draggable
              onDragStart={(e) => handleDragStart(e, item)}
            >
              <img src={item.url} alt={item.name} />
              <div className="meta">
                <div className="name">{item.name}</div>
                <div className="actions">
                  <button onClick={() => placeIntoDocument(item)}>Place</button>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}