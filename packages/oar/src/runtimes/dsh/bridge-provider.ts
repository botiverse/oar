/**
 * A host-declared provider, confirmed before any agent exists: the patch row OAR
 * wrote must be the applied `llm-pi-ai` config, the plugin must be active, and
 * the model plane must resolve every declared model. Anything less is refused,
 * never run in another route. Ids and names only: the credential is the
 * environment variable's NAME.
 */
export const dshProviderSource = String.raw`
async function confirmProvider(ctx, loader, wanted) {
  requireMethod(loader, "entries", "dshProvider");
  const entry = [...loader.entries()].find((row) => row.options?.id === wanted.pluginId);
  if (entry === undefined) {
    throw refusal("option_not_applied", "This DSH does not mount " + wanted.pluginId + ", so OAR cannot register the declared provider " + wanted.id, "dshProvider");
  }
  if (entry.options?.name !== wanted.pluginName) {
    throw refusal("option_not_applied", "DSH " + wanted.pluginId + " entry does not match " + wanted.pluginName, "dshProvider");
  }
  if (entry.options?.disabled === true) {
    throw refusal("option_not_applied", "DSH has " + wanted.pluginId + " disabled in this profile, so the declared provider " + wanted.id + " is not mounted", "dshProvider");
  }
  const applied = entry.options?.config?.providers?.[wanted.id];
  if (applied === undefined || applied === null) {
    throw refusal("option_not_applied", "DSH did not apply the declared provider " + wanted.id + " to " + wanted.pluginId, "dshProvider");
  }
  if (applied.api !== wanted.api || applied.baseURL !== wanted.baseURL || (applied.apiKeyEnv ?? null) !== (wanted.apiKeyEnv ?? null)) {
    throw refusal("option_not_applied", "DSH applied " + wanted.id + " with another api, baseURL or credential variable than declared", "dshProvider");
  }
  const appliedModels = (Array.isArray(applied.models) ? applied.models : []).map((model) => model?.id);
  const missing = wanted.models.filter((id) => !appliedModels.includes(id));
  if (missing.length > 0) {
    throw refusal("option_not_applied", "DSH did not apply the declared " + wanted.id + " models " + missing.join(", "), "dshProvider");
  }
  const fiber = entry.fiber;
  requireMethod(fiber, "await", "dshProvider");
  await fiber.await();
  if (fiber.state !== 2) {
    throw refusal("option_not_applied", "DSH " + wanted.pluginId + " is not active (native state " + fiber.state + ")", "dshProvider");
  }
  const llm = ctx.get("llm");
  requireMethod(llm, "resolveModelInfo", "dshProvider");
  for (const id of wanted.models) {
    try { await llm.resolveModelInfo(wanted.id, id); }
    catch (error) { throw refusal("option_not_applied", "DSH's model plane does not resolve " + wanted.id + "/" + id + ": " + String(error?.message ?? error), "dshProvider"); }
  }
}
`;
