import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("Missing coxswain root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
