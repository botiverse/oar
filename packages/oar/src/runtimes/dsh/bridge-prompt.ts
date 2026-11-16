/** Native prompt setup source embedded in the private bridge, using its validation helpers. */
export const dshPromptSource = String.raw`  // Register on the agent scope, never the process/root context. Native scope
  // disposal owns these sections. Native child agents use their own scopes.
  const configurePrompt = (agent, request) => {
    const replacement = request.systemPrompt;
    const append = request.appendSystemPrompt;
    if (replacement === undefined && append === undefined) { return; }
    const capability = replacement === undefined ? "appendSystemPrompt" : "systemPrompt";
    const prompt = agent.scope?.ctx?.systemPrompt;
    requireMethod(prompt, "section", capability);
    requireMethod(prompt, "getSectionOrder", capability);
    requireMethod(prompt, "assemble", capability);
    requireMethod(agent.scope.ctx, "on", capability);
    const order = prompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX") + 1;
    // A complete section excludes every ordinary section, so a simultaneous
    // append must be part of that one literal replacement.
    const text = replacement === undefined ? append : replacement + (append === undefined ? "" : "\n\n" + append);
    prompt.section({ name: "oar:system-prompt", order, text, interpolate: false, ...(replacement === undefined ? {} : { complete: true }) });
    // Existing creation listeners may install a native persona or queue input.
    // Confirm after those listeners, still inside native publication maintenance.
    agent.scope.ctx.on("agent/created", async ({ agent: created }) => {
      if (created !== agent) { return; }
      try {
        const assembly = await prompt.assemble({ agent, scope: agent });
        const sections = assembly.sections;
        const own = sections.find((section) => section.name === "oar:system-prompt");
        if (own?.text !== text || own.interpolate !== false || (replacement !== undefined && sections.length !== 1)) {
          throw new Error("The native prompt assembly did not retain the requested literal section");
        }
      } catch (error) {
        const failure = refusal("prompt_not_applied", "DSH could not apply " + capability + ": " + String(error?.message ?? error), capability);
        failure.cause = error;
        throw failure;
      }
    });
  };

`;
