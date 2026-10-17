export function timeNodeAction(label, action, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.timeNodeAction = action;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  const paths = {
    up: "M12 4 3 13h6v7h6v-7h6L12 4z",
    down: "m12 20 9-9h-6V4H9v7H3l9 9z",
    edit: "M3 17.2V21h3.8L18 9.8 14.2 6 3 17.2zm18-10.4c.4-.4.4-1 0-1.4l-2.4-2.4c-.4-.4-1-.4-1.4 0l-1.9 1.9 3.8 3.8L21 6.8z",
    restore: "M12 3a9 9 0 1 1-8.5 12h2.2A7 7 0 1 0 7 7.1L10 10H2V2l3.5 3.5A9 9 0 0 1 12 3z",
    delete: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm4.7 13.3-1.4 1.4L12 13.4l-3.3 3.3-1.4-1.4 3.3-3.3-3.3-3.3 1.4-1.4 3.3 3.3 3.3-3.3 1.4 1.4-3.3 3.3 3.3 3.3z"
  };
  if (action === "delete") {
    const circle = document.createElementNS(svg.namespaceURI, "circle"); circle.setAttribute("cx", "12"); circle.setAttribute("cy", "12"); circle.setAttribute("r", "10"); circle.setAttribute("fill", "var(--time-delete-fill, #a52525)"); svg.append(circle);
    path.setAttribute("d", "M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5"); path.setAttribute("fill", "none"); path.setAttribute("stroke", "#ffffff"); path.setAttribute("stroke-width", "2.4");
  } else path.setAttribute("d", paths[action]);
  svg.append(path); button.append(svg);
  if (handler) button.addEventListener("click", handler);
  return button;
}
