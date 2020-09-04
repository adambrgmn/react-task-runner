import { useEffect, useLayoutEffect, useMemo } from 'react';
import {
  createMachine,
  assign,
  spawn,
  Interpreter,
  StateMachine,
  send,
  sendParent,
  ActionTypes,
  State,
} from 'xstate';
import { pure } from 'xstate/lib/actions';
import { useMachine } from '@xstate/react';

function canUseDOM() {
  return !!(
    typeof window !== 'undefined' &&
    window.document &&
    window.document.createElement
  );
}

const useIsomorphicLayoutEffect = canUseDOM() ? useLayoutEffect : useEffect;

// -----------------
// ----- TYPES -----
// -----------------
export type TaskContext<Ctx extends Record<string, unknown> = any> = {
  name: string;
  isSubTask: boolean;
  subTaskConfigs?: TaskConfig<Ctx>[];
  subTasks?: TaskMachineInterpreter[];
  action?: (context: Ctx) => Promise<unknown> | unknown;
  error?: unknown;
  shouldRejectImmediately?: boolean;
  onCancel?: (context: Ctx) => any;
  onResolved?: (context: Ctx) => any;
  onRejected?: (context: Ctx) => any;
  sharedContext: Ctx;
};

export type TaskConfig<Ctx extends Record<string, unknown>> = {
  name: string;
  subTasks?: SubTaskConfig<Ctx>[];
  action?: (context: Ctx) => Promise<unknown> | unknown;
  shouldRejectImmediately?: boolean;
  onCancel?: (context: Ctx) => any;
  onResolved?: (context: Ctx) => any;
  onRejected?: (context: Ctx) => any;
};

export type SubTaskConfig<Ctx extends Record<string, unknown>> = {
  name: string;
  subTasks?: SubTaskConfig<Ctx>[];
  action?: (context: Ctx) => Promise<unknown> | unknown;
};

type AddTaskEvent = { type: 'ADD_TASK'; task: SubTaskConfig<any> };
type RemoveTaskEvent = { type: 'REMOVE_TASK'; id: string };
type TaskEvent =
  | AddTaskEvent
  | RemoveTaskEvent
  | { type: 'INIT' }
  | { type: 'CANCEL' }
  | { type: 'RESOLVE'; result: unknown }
  | { type: 'REJECT'; error: unknown }
  | { type: ActionTypes.Update };

type TaskState =
  | { value: 'idle'; context: TaskContext }
  | { value: 'pending'; context: TaskContext }
  | { value: 'cancelled'; context: TaskContext }
  | { value: 'resolved'; context: TaskContext & { result: unknown } }
  | { value: 'rejected'; context: TaskContext & { error: unknown } };

type TaskMachineState<Ctx extends Record<string, unknown> = any> = State<
  TaskContext<Ctx>,
  TaskEvent,
  any,
  TaskState
>;
type TaskMachineType = StateMachine<TaskContext, any, TaskEvent, TaskState>;
type TaskMachineInterpreter = Interpreter<
  TaskContext,
  any,
  TaskEvent,
  TaskState
>;

// ---------------------------
// ----- ACTION CREATORS -----
// ---------------------------
const actions = {
  sendInitToNext: send<TaskContext, any, any>('INIT', {
    to: (context: TaskContext) => {
      return context.subTasks!.find((actor) =>
        actor.state.matches('idle'),
      ) as Interpreter<any, any, any>;
    },
  }),
  addTask: {
    internal: true,
    actions: assign<TaskContext, AddTaskEvent>({
      subTasks: (context, event) => {
        return [...(context.subTasks ?? []), spawnSubTask(event.task, context)];
      },
    }),
  },
  removeTask: {
    internal: true,
    actions: [
      assign<TaskContext, RemoveTaskEvent>({
        subTasks: (context, event) => {
          return Array.isArray(context.subTasks)
            ? context.subTasks.filter((actor) => actor.id !== event.id)
            : context.subTasks;
        },
      }),
      'passEventDown',
    ],
  },
  cancel: { target: 'cancelled', actions: ['passEventDown'] },
};

// -------------------
// ----- MACHINE -----
// -------------------
const TaskMachine: TaskMachineType = createMachine<
  TaskContext,
  TaskEvent,
  TaskState
>(
  {
    id: 'task',
    strict: true,
    initial: 'idle',
    states: {
      idle: {
        entry: [
          assign({
            subTasks: (context) => {
              return context.subTaskConfigs?.map((config) =>
                spawnSubTask(config, context),
              );
            },
          }),
        ],
        on: {
          ADD_TASK: [actions.addTask],
          REMOVE_TASK: [actions.removeTask],
          CANCEL: [actions.cancel],
          INIT: 'pending',
        },
      },
      pending: {
        on: {
          ADD_TASK: [actions.addTask],
          REMOVE_TASK: [actions.removeTask],
          CANCEL: [actions.cancel],
        },
        initial: 'pending_tasks',
        states: {
          pending_tasks: {
            always: [
              { cond: 'hasIdleSubTasks', target: 'subTasks' },
              { cond: 'hasAction', target: 'action' },
              { target: '#resolved' },
            ],
          },
          subTasks: {
            entry: [actions.sendInitToNext],
            on: {
              RESOLVE: [
                {
                  cond: 'hasIdleSubTasks',
                  internal: true,
                  actions: [actions.sendInitToNext],
                },
                { cond: 'hasAction', target: 'action' },
                { target: '#resolved' },
              ],
              REJECT: [
                {
                  cond: 'shouldRejectImmediately',
                  target: '#rejected',
                  actions: assign({ error: (_, event) => event.error }),
                },
                {
                  cond: 'hasIdleSubTasks',
                  internal: true,
                  actions: [actions.sendInitToNext],
                },
                { cond: 'hasAction', target: 'action' },
                { target: '#rejected' },
              ],
            },
          },
          action: {
            invoke: [
              {
                id: 'task-action',
                src: 'runAction',
                onDone: [{ target: '#resolved' }],
                onError: [
                  {
                    target: '#rejected',
                    actions: assign({ error: (_, event) => event.data }),
                  },
                ],
              },
            ],
          },
        },
      },
      cancelled: { id: 'cancelled', type: 'final', entry: ['onCancel'] },
      resolved: {
        id: 'resolved',
        type: 'final',
        entry: [
          pure((ctx) => {
            if (ctx.isSubTask) return sendParent('RESOLVE');
          }),
          'onRejected',
        ],
      },
      rejected: {
        id: 'rejected',
        type: 'final',
        entry: [
          pure((ctx) => {
            if (ctx.isSubTask) return sendParent('REJECT');
          }),
          'onRejected',
        ],
      },
    },
  },
  {
    services: {
      runAction: async (context) => {
        if (typeof context.action === 'function') {
          return context.action(context.sharedContext) as any;
        }
      },
    },
    actions: {
      onCancel: (context) => {
        if (typeof context.onCancel === 'function') {
          context.onCancel(context.sharedContext);
        }
      },
      onResolved: (context) => {
        if (typeof context.onResolved === 'function') {
          context.onResolved(context.sharedContext);
        }
      },
      onRejected: (context) => {
        if (typeof context.onRejected === 'function') {
          context.onRejected(context.sharedContext);
        }
      },
      passEventDown: (context, event) => {
        for (let actor of context.subTasks ?? []) {
          if (!actor.state.done) actor.send(event);
        }
      },
    },
    guards: {
      hasIdleSubTasks: (context) => {
        if (!Array.isArray(context.subTasks)) return false;
        return context.subTasks.some((task) => task.state.matches('idle'));
      },
      hasAction: (context) => {
        return typeof context.action === 'function';
      },
      shouldRejectImmediately: (context) => !!context.shouldRejectImmediately,
    },
  },
);

function spawnSubTask<Ctx extends Record<string, unknown>>(
  { subTasks, ...config }: SubTaskConfig<Ctx> | TaskConfig<Ctx>,
  {
    shouldRejectImmediately,
    sharedContext,
  }: Pick<TaskContext<Ctx>, 'shouldRejectImmediately' | 'sharedContext'>,
): TaskMachineInterpreter {
  let childContext: TaskContext<Ctx> = {
    ...config,
    isSubTask: true,
    shouldRejectImmediately,
    sharedContext,
  };

  let ref = spawn(TaskMachine.withContext(childContext), { sync: false });
  for (let subTask of subTasks ?? []) {
    ref.send({ type: 'ADD_TASK', task: subTask });
  }

  return ref;
}

// ---------------------------
// ----- MACHINE CREATOR -----
// ---------------------------
export function createTaskMachine<Ctx extends Record<string, unknown> = any>({
  subTasks,
  ...task
}: TaskConfig<Ctx>): TaskMachineType {
  let sharedContext = {} as Ctx;

  let machine = TaskMachine.withContext({
    ...task,
    isSubTask: false,
    sharedContext,
    subTaskConfigs: subTasks,
  });

  return machine;
}

// -----------------
// ----- HOOKS -----
// -----------------
type UseTaskMachineOptions = {
  initImmediately?: boolean;
};

export type UseTaskMachineState<Ctx extends Record<string, unknown>> = {
  name: string;
  done: TaskMachineState<Ctx>['done'];
  value: TaskMachineState<Ctx>['value'];
  matches: TaskMachineState<Ctx>['matches'];
  subTasks?: UseTaskMachineState<Ctx>[];
  context: Ctx;
};

type UseTaskMachineMethods = {
  init: () => void;
  cancel: () => void;
};

type UseTaskMachineReturnType<Ctx extends Record<string, unknown>> = [
  UseTaskMachineState<Ctx>,
  UseTaskMachineMethods,
];

export function useTaskMachine<Ctx extends Record<string, unknown>>(
  task: TaskConfig<Ctx>,
  { initImmediately = false }: UseTaskMachineOptions = {},
): UseTaskMachineReturnType<Ctx> {
  const [internalState, send] = useMachine<TaskContext<Ctx>, TaskEvent>(
    createTaskMachine<Ctx>(task),
  );

  useIsomorphicLayoutEffect(() => {
    if (initImmediately && internalState.matches('idle')) {
      send('INIT');
    }
  }, [initImmediately, internalState]);

  const state: UseTaskMachineState<Ctx> = useMemo(() => {
    return mapInternalState(internalState);
  }, [internalState]);

  const methods: UseTaskMachineMethods = useMemo(
    () => ({
      init: () => send('INIT'),
      cancel: () => send('CANCEL'),
    }),
    [],
  );

  return [state, methods];
}

function mapInternalState<Ctx extends Record<string, unknown>>(
  state: TaskMachineState<Ctx>,
): UseTaskMachineState<Ctx> {
  return {
    name: state.context.name,
    done: state.done,
    value: state.value,
    matches: state.matches,
    subTasks: state.context.subTasks?.map((subTask) =>
      mapInternalState(subTask.state),
    ),
    context: state.context.sharedContext,
  };
}
