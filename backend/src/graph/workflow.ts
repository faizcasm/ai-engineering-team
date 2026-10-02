import AppError from "../services/AppError.js";

import {
  assignNode,
  executeNode,
  finalizeNode,
  planNode,
  reviewNode,
} from "./nodes.js";

import { nextPendingTask } from "./state.js";
import type { WorkflowState } from "./state.js";

/* =====================================================
   RUNTIME TYPES
===================================================== */

export const END = "__end__";

export type GraphNode<S> = (
  state: S
) => Promise<Partial<S>> | Partial<S>;

export type GraphRoute<S> = (state: S) => string;

export type GraphEventKind =
  | "node_start"
  | "node_end"
  | "end";

export type GraphEndReason =
  | "completed"
  | "max_steps"
  | "max_visits";

export interface GraphEvent<S> {
  type: GraphEventKind;
  node: string | null;
  step: number;
  state: S;
  reason?: GraphEndReason;
}

export interface RunOptions {
  maxSteps?: number;
  maxVisits?: number;
}

export interface CompiledGraph<S extends { status: string }> {
  readonly nodes: readonly string[];

  invoke(input: S, options?: RunOptions): Promise<S>;

  stream(
    input: S,
    options?: RunOptions
  ): AsyncGenerator<GraphEvent<S>, void, void>;
}

const DEFAULT_MAX_STEPS = 128;
const DEFAULT_MAX_VISITS = 48;

/* =====================================================
   RUNTIME
===================================================== */

function withStatus<S extends { status: string }>(
  state: S,
  status: string
): S {
  return { ...state, status } as S;
}

export class StateGraph<S extends { status: string }> {
  private readonly nodes = new Map<string, GraphNode<S>>();
  private readonly edges = new Map<string, GraphRoute<S>>();
  private entry: string | null = null;

  addNode(name: string, node: GraphNode<S>): this {
    if (name === END) {
      throw new AppError(
        `"${END}" is a reserved graph name`,
        500
      );
    }

    if (this.nodes.has(name)) {
      throw new AppError(
        `Graph node "${name}" is already registered`,
        500
      );
    }

    this.nodes.set(name, node);

    return this;
  }

  setEntryPoint(name: string): this {
    this.entry = name;

    return this;
  }

  addEdge(from: string, to: string): this {
    this.edges.set(from, () => to);

    return this;
  }

  addConditionalEdge(
    from: string,
    route: GraphRoute<S>
  ): this {
    this.edges.set(from, route);

    return this;
  }

  compile(options: RunOptions = {}): CompiledGraph<S> {
    const nodes = new Map(this.nodes);
    const edges = new Map(this.edges);

    const entry = this.entry || nodes.keys().next().value;

    if (!entry || !nodes.has(entry)) {
      throw new AppError(
        "Graph has no entry point. Call setEntryPoint() first.",
        500
      );
    }

    const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    const maxVisits = options.maxVisits ?? DEFAULT_MAX_VISITS;

    const resolveLimits = (
      runOptions?: RunOptions
    ): Required<RunOptions> => ({
      maxSteps: runOptions?.maxSteps ?? maxSteps,
      maxVisits: runOptions?.maxVisits ?? maxVisits,
    });

    const run = async function* (
      input: S,
      limits: Required<RunOptions>
    ): AsyncGenerator<GraphEvent<S>, void, void> {
      let state = input;
      let current: string = entry;
      let step = 0;

      const visits = new Map<string, number>();

      while (current !== END) {
        const node = nodes.get(current);

        if (!node) {
          throw new AppError(
            `Graph has no node "${current}"`,
            500
          );
        }

        // Cycle protection: bound how often any single node may run
        // and how many steps a run may take overall.
        const visited = visits.get(current) ?? 0;
        const overVisits = visited + 1 > limits.maxVisits;
        const overSteps = step + 1 > limits.maxSteps;

        if (overVisits || overSteps) {
          state = withStatus(state, "max_iterations");

          yield {
            type: "end",
            node: current,
            step,
            state,

            reason: overVisits
              ? "max_visits"
              : "max_steps",
          };

          return;
        }

        visits.set(current, visited + 1);

        yield {
          type: "node_start",
          node: current,
          step,
          state,
        };

        const partial = await node(state);
        state = { ...state, ...partial };
        step += 1;

        yield {
          type: "node_end",
          node: current,
          step,
          state,
        };

        const route = edges.get(current);
        current = route ? route(state) : END;
      }

      yield {
        type: "end",
        node: null,
        step,
        state,
        reason: "completed",
      };
    };

    return {
      nodes: [...nodes.keys()],

      async invoke(
        input: S,
        runOptions?: RunOptions
      ): Promise<S> {
        const limits = resolveLimits(runOptions);
        let finalState = input;

        for await (const event of run(input, limits)) {
          if (event.type === "end") {
            finalState = event.state;
          }
        }

        return finalState;
      },

      stream(
        input: S,
        runOptions?: RunOptions
      ): AsyncGenerator<GraphEvent<S>, void, void> {
        return run(input, resolveLimits(runOptions));
      },
    };
  }
}

/* =====================================================
   TEAM WORKFLOW
===================================================== */

function routeAfterReview(
  state: WorkflowState
): string {
  if (state.approved) {
    return "finalize";
  }

  if (state.iteration >= state.maxIterations) {
    return "finalize";
  }

  if (!nextPendingTask(state)) {
    return "finalize";
  }

  return "execute";
}

export function createTeamGraph(): CompiledGraph<WorkflowState> {
  return new StateGraph<WorkflowState>()
    .setEntryPoint("plan")
    .addNode("plan", planNode)
    .addNode("assign", assignNode)
    .addNode("execute", executeNode)
    .addNode("review", reviewNode)
    .addNode("finalize", finalizeNode)
    .addEdge("plan", "assign")
    .addEdge("assign", "execute")

    .addConditionalEdge("execute", (state) =>
      nextPendingTask(state) ? "execute" : "review"
    )

    .addConditionalEdge("review", routeAfterReview)
    .addEdge("finalize", END)
    .compile();
}

export const teamGraph: CompiledGraph<WorkflowState> =
  createTeamGraph();

export const TEAM_GRAPH_NODES = teamGraph.nodes;
