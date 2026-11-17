/** Native goal calls; synchronous mutations retain their own durable events. */
export const dshGoalSource = String.raw`
  const goalService = () => {
    const goals = ctx.get("goals");
    for (const method of ["get", "create", "edit", "pause", "resume", "complete", "clear"]) {
      requireMethod(goals, method, "goals");
    }
    return goals;
  };
  const observeGoal = (agent, goals) => {
    const goal = goals.get(agent) ?? null;
    write({ type: "native", channel: "goal/read", sessionId: agent.session.id, goal });
    return { goal };
  };
  const goalCommands = {
    goalConfirm() { goalService(); return {}; },
    goalRead(request) { return observeGoal(owned(request.sessionId).agent, goalService()); },
    goalClear(request) {
      const { agent } = owned(request.sessionId);
      const goals = goalService();
      const current = goals.get(agent);
      if (current !== undefined) { goals.clear(agent, current); }
      return observeGoal(agent, goals);
    },
    goalSet(request) {
      const { agent } = owned(request.sessionId);
      const goals = goalService();
      const options = request.options;
      let current = goals.get(agent);
      if (current === undefined || current.phase === "complete") {
        current = goals.create(agent, { objective: options.objective });
      } else if (current.objective !== options.objective) {
        current = goals.edit(agent, current, { objective: options.objective });
      }
      if (options.status === "active" && (current.phase !== "active" || current.activation !== "armed")) { goals.resume(agent, current); }
      if (options.status === "paused" && current.phase !== "paused") { goals.pause(agent, current); }
      if (options.status === "complete" && current.phase !== "complete") { goals.complete(agent, current); }
      return observeGoal(agent, goals);
    },
  };
`;
