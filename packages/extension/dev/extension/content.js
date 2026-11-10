// Development-only test extension: writes a marker the fixture pages and tests can read.
/* global document */
document.documentElement.dataset.chromexTestExtension = "1"
const marker = document.createElement("p")
marker.id = "test-extension-marker"
marker.textContent = "test extension loaded"
;(document.body ?? document.documentElement).append(marker)
