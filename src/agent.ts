import {
  ActorRef,
  ActorRefFrom,
  AnyActorLogic,
  AnyEventObject,
  AnyMachineSnapshot,
  EventFromLogic,
  EventObject,
  InputFrom,
  SnapshotFrom,
  createActor,
} from 'xstate';

// export type AgentExperiences<TState, TReward> = Record<
//   string, // serialized state
//   Record<
//     string, // serialized event
//     {
//       state: TState;
//       reward: TReward;
//     }
//   >
// >;
export interface AgentExperience<TState, TEvent extends AnyEventObject> {
  prevState: TState | undefined;
  event: TEvent;
  nextState: TState;
}

export type AgentPlan<TLogic extends AnyActorLogic> = Array<{
  /**
   * The current state
   */
  state: SnapshotFrom<TLogic>;
  /**
   * The event to execute
   */
  event: EventFromLogic<TLogic>;
  /**
   * The expected next state
   */
  nextState: SnapshotFrom<TLogic>;
}>;

export interface AgentModel<
  TLogic extends AnyActorLogic,
  TReward,
  TState extends SnapshotFrom<TLogic> = SnapshotFrom<TLogic>,
  TEvent extends EventFromLogic<TLogic> = EventFromLogic<TLogic>
> {
  policy: ({
    logic,
    state,
    goal,
  }: {
    logic: TLogic;
    state: TState;
    goal: string;
  }) => Promise<AgentPlan<TState>>;
  getExperiences: () => Promise<Array<AgentExperience<TState, TEvent>>>; // TODO: TLogic instead?
  addExperience: (experience: AgentExperience<TState, TEvent>) => void;
  getLogic: ({
    experiences,
  }: {
    experiences: Array<AgentExperience<TState, TEvent>>; // TODO: TLogic instead?
  }) => Promise<TLogic>;
  getNextEvents: ({
    logic,
    state,
  }: {
    logic: TLogic;
    state: TState;
  }) => Promise<AnyEventObject[]>;
  getPlans: ({
    logic,
    state,
    goal,
  }: {
    logic: TLogic;
    state: TState;
    goal: string;
  }) => Promise<Array<AgentPlan<TState>>>;
  getNextPlan: ({
    logic,
    state,
    goal,
  }: {
    logic: TLogic;
    state: TState;
    goal: string;
  }) => AgentPlan<TState>;
  getReward: ({
    logic,
    state,
    goal,
    action,
  }: {
    logic: TLogic;
    state: TState;
    goal: TState;
    action: EventObject;
  }) => Promise<TReward>;
}

export interface AgentLogic<T> {
  /**
   * The next possible actions (represented by events) that the agent can take
   * based on the current state of the environment
   */
  getActions(state: T): Promise<AnyEventObject[]>;
  getPlan(state: T, goal: any): Promise<Array<[T, EventObject]>>;
}

export interface Agent<TLogic extends AnyActorLogic>
  extends ActorRef<SnapshotFrom<TLogic>, EventFromLogic<TLogic>> {
  model: AgentModel<TLogic, any>;
  goal: string;
}

export function createAgent<TLogic extends AnyActorLogic>(
  logic: TLogic,
  input: InputFrom<TLogic>,
  goal: string // TODO: () => string ?
): Agent<TLogic> {
  const experiences: Array<AgentExperience<any, any>> = [];

  const agentModel: AgentModel<TLogic, any> = {
    // addExperience: (experience) =>  {
    //   experiences.push(experience);
    // },
  } as unknown as AgentModel<TLogic, any>;

  const actor = createActor(logic, {
    input,
    inspect: (inspEv) => {
      if (inspEv.type === '@xstate.snapshot') {
        agentModel.addExperience({
          prevState: experiences[experiences.length - 1]?.nextState,
          nextState: (inspEv.snapshot as AnyMachineSnapshot).value,
          event: inspEv.event as EventFromLogic<TLogic>,
        });
      }
    },
  });

  // Act on environment
  actor.subscribe(async (s) => {
    const experiences = await agentModel.getExperiences();
    const nextPlan = agentModel.getNextPlan({
      logic: await agentModel.getLogic({ experiences }),
      goal,
      state: s,
    });

    // TODO: race conditions!
    if (nextPlan?.[0]) {
      const nextThing = nextPlan[0];
      actor.send(nextThing.event);
    }
  });

  return {
    ...actor,
    goal,
    model: agentModel,
  } as unknown as Agent<TLogic>; // TODO: fix types
}
