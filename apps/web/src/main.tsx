if (document.title.includes("%")) document.title = "BizDemo Service Manager";
import React from "react";
import ReactDOM from "react-dom/client";
import "@/lib/i18n";
import "@/styles.css";
import App from "@/App";
import { keepFocusedFieldVisible } from "@/lib/mobile";
import { startOfflineSync } from "@/lib/offline";

keepFocusedFieldVisible();
// checkpoints pressed offline are sent as soon as the phone is back online (real time kept)
startOfflineSync(() => undefined);

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
