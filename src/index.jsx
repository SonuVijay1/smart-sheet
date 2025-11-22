import React from "react";

import "./styles.css";
import { PanelController } from "./controllers/PanelController.jsx";
import { CommandController } from "./controllers/CommandController.jsx";
import { About } from "./components/About.jsx";
import PhotoBrowser from "./components/PhotoBrowser.jsx";   // your main panel

import { entrypoints } from "uxp";

// ABOUT dialog
const aboutController = new CommandController(
  ({ dialog }) => <About dialog={dialog} />,
  {
    id: "showAbout",
    title: "UXP Quite Space Smart Sheet Plugin",
    size: { width: 480, height: 480 },
  }
);

// MAIN PANEL — renamed from "demos" → "smartsheet"
const smartsheetController = new PanelController(() => <PhotoBrowser />, {
  id: "smartsheet",
  menuItems: [
    {
      id: "reload",
      label: "Reload Plugin",
      enabled: true,
      checked: false,
      oninvoke: () => location.reload(),
    },
    {
      id: "dialog1",
      label: "About this Plugin",
      enabled: true,
      checked: false,
      oninvoke: () => aboutController.run(),
    },
  ],
});

// REGISTER ONLY ONE PANEL
entrypoints.setup({
  plugin: {
    create(plugin) {
      console.log("created", plugin);
    },
    destroy() {
      console.log("destroyed");
    },
  },
  commands: {
    showAbout: aboutController,
  },
  panels: {
    smartsheet: smartsheetController, // only this panel now
  },
});
