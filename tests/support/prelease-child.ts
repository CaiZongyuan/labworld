// Real process stalled before it can open the database or acquire its directory lease.
console.log(
  JSON.stringify({ event: 'fixture.prelease_ready', pid: process.pid }),
);
setInterval(() => {}, 1000);
