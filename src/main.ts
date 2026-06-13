// whatspacd — entry point.
//
// Wires the persistent agent to the two heads (web + RF terminal) from
// configuration. Built up across the ADR slices; for now it is a stub so the
// project has a valid entry point.

async function main(): Promise<void> {
  // TODO(slice-2+): load config, connect the RHP transport, start the agent,
  // then start the enabled heads.
  console.log("whatspacd starting…");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
