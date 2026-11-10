/** Find the ref of one snapshot line, for example `[e3] textbox "Name"`. */
export function refFor(snapshot: string, role: string, name: string): string {
  const line = snapshot.split("\n").find((text) => text.includes(`] ${role} "${name}"`))
  const ref = line?.match(/^\s*\[(e\d+)\]/)?.[1]
  if (!ref) throw new Error(`No ${role} "${name}" in snapshot:\n${snapshot}`)
  return ref
}
