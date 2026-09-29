if (document.title.includes("%")) document.title = "BizDemo Service Manager";
import React from "react";
import ReactDOM from "react-dom/client";
import "@/lib/i18n";
import "@/styles.css";
import App from "@/App";

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
