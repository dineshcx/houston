// Sets the theme before first paint so dark mode doesn't flash white. Loaded synchronously in
// <head>, as a file because the app's CSP allows no inline scripts. localStorage.theme is
// "light", "dark" or "system" (the default).
const t = localStorage.theme || "system";
if (t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches)) document.documentElement.classList.add("dark");
