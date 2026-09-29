if (document.title.includes("%")) document.title = "BizDemo Service Manager";
import React from "react";
import ReactDOM from "react-dom/client";
import "@/lib/i18n";
import "@/styles.css";
import App from "@/App";
import { keepFocusedFieldVisible } from "@/lib/mobile";

keepFocusedFieldVisible();

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
