// Use a numeric TEST-NET address so DNS and proxy configuration are irrelevant.
import net from "node:net";

console.log("probe started");
const socket = net.connect(443, "192.0.2.1");
socket.on("connect", () => {
  console.log("connected");
  socket.end();
});
socket.on("error", (error) => {
  console.log(error.syscall, error.code);
  process.exitCode = 1;
});
socket.setTimeout(5000, () => {
  console.log("timed out");
  socket.destroy();
  process.exitCode = 2;
});
