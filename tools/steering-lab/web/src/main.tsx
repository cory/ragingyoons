import React from "react";
import { createRoot } from "react-dom/client";
import { LabView } from "./LabView.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LabView />
  </React.StrictMode>,
);
