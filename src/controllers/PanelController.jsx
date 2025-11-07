import React from "react";
import ReactDOM from "react-dom";

const _id = Symbol("_id");
const _root = Symbol("_root");
const _attachment = Symbol("_attachment");
const _Component = Symbol("_Component");
const _menuItems = Symbol("_menuItems");

export class PanelController {
    constructor(Component, {id, menuItems} = {}) {
        this[_id] = null;
        this[_root] = null;
        this[_attachment] = null;
        this[_Component] = null;
        this[_menuItems] = [];

        this[_Component] = Component;
        this[_id] = id;
        this[_menuItems] = menuItems || [];

        // Ensure menu items have proper structure
        this.menuItems = this[_menuItems].map(menuItem => ({
            id: menuItem.id,
            label: menuItem.label,
            enabled: menuItem.enabled !== undefined ? menuItem.enabled : true,
            checked: menuItem.checked !== undefined ? menuItem.checked : false,
            oninvoke: menuItem.oninvoke
        }));

        // Bind methods
        ["create", "show", "hide", "destroy", "invokeMenu"].forEach(fn => this[fn] = this[fn].bind(this));
    }

    create() {
        this[_root] = document.createElement("div");
        this[_root].style.height = "100vh";
        this[_root].style.overflow = "auto";
        this[_root].style.padding = "8px";

        // render the component with props in a robust way
        ReactDOM.render(React.createElement(this[_Component], { panel: this }), this[_root]);

        return this[_root];
    }

    show(event) {
        try {
            if (!this[_root]) this.create();
            this[_attachment] = event.node;
            this[_attachment].appendChild(this[_root]);
        } catch (err) {
            console.error("PanelController.show() error:", err);
        }
    }

    hide() {
        try {
            if (this[_attachment] && this[_root]) {
                this[_attachment].removeChild(this[_root]);
                this[_attachment] = null;
            }
        } catch (err) {
            console.error("PanelController.hide() error:", err);
        }
    }

    destroy() {
        try {
            if (this[_root]) {
                ReactDOM.unmountComponentAtNode(this[_root]);
                this[_root] = null;
            }
        } catch (err) {
            console.error("PanelController.destroy() error:", err);
        }
    }

    invokeMenu(id) {
        try {
            const menuItem = this[_menuItems].find(item => item.id === id);
            if (menuItem && menuItem.oninvoke) {
                menuItem.oninvoke();
            }
        } catch (err) {
            console.error("PanelController.invokeMenu() error:", err);
        }
    }
}
