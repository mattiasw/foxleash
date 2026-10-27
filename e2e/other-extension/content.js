// Puts a frame of this add-on's own page into each element of the page marked with
// data-addon-slot: "iframe" an iframe, "shadow" an iframe in a closed shadow root.
const PAGE = browser.runtime.getURL("frame.html");
const FILL = "display: block; width: 100%; height: 100%; border: 0; margin: 0; padding: 0";

for (const slot of document.querySelectorAll("[data-addon-slot]")) {
  slot.append(embedderFor(slot.getAttribute("data-addon-slot")));
}

function embedderFor(kind) {
  if (kind === "shadow") {
    const host = document.createElement("div");
    host.style.cssText = FILL;
    host.attachShadow({ mode: "closed" }).append(frame());
    return host;
  }
  return frame();
}

function frame() {
  const element = document.createElement("iframe");
  element.style.cssText = FILL;
  element.src = PAGE;
  return element;
}
