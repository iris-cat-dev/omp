process.on("message", (message) => {
  if (message?.type !== "omp_frame") return;
  process.send?.(message);
});
