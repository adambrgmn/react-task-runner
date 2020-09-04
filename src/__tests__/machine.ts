import { interpret, State } from 'xstate';
import { createTaskMachine, TaskConfig, TaskContext } from '..';

declare global {
  namespace jest {
    interface Matchers<R> {
      toMatchState(expected: string): R;
      toHaveSubTasksMatchingState(
        expected: string,
        length: number | 'every' | 'some',
      ): R;
    }
  }
}

let flushPromises = () => new Promise((resolve) => setImmediate(resolve));
let delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

it('should not complain about badly configured state chart', () => {
  let service = interpret(createTaskMachine({ name: 'test' }));
  expect(() => service.start()).not.toThrow();
});

it('should initialize sub tasks on their idle state when configured', () => {
  let task: TaskConfig<any> = {
    name: 'test',
    subTasks: [
      { name: 'sub task 1', action: jest.fn() },
      { name: 'sub task 2', action: jest.fn() },
      { name: 'sub task 3', action: jest.fn() },
    ],
  };

  let service = interpret(createTaskMachine(task));
  service.start();

  expect(service.state.matches('idle'));
  expect(service.state.context.subTasks).toHaveLength(3);
  expect(service.state).toHaveSubTasksMatchingState('idle', 'every');

  for (let subTask of task.subTasks!) {
    expect(subTask.action).not.toHaveBeenCalled();
  }

  service.stop();
});

it('will run all sub tasks in sync marking it self as done when all is completed', async () => {
  jest.useFakeTimers();
  let task: TaskConfig<any> = {
    name: 'test',
    subTasks: [
      {
        name: 'sub task 1',
        action: jest.fn().mockImplementation(() => delay(100)),
      },
      {
        name: 'sub task 2',
        action: jest.fn().mockImplementation(() => delay(100)),
      },
      {
        name: 'sub task 3',
        action: jest.fn().mockImplementation(() => delay(100)),
      },
    ],
  };

  let service = interpret(createTaskMachine(task));

  service.start();
  service.send('INIT');

  expect(service.state).toMatchState('pending.subTasks');

  for (let i = 0; i < 3; i++) {
    expect(task.subTasks[i].action).toHaveBeenCalled();
    if (task.subTasks[i + 1]) {
      expect(task.subTasks[i + 1].action).not.toHaveBeenCalled();
    }
    jest.advanceTimersToNextTimer();
    await flushPromises();
  }

  expect(service.state).toMatchState('resolved');
  expect(service.state).toHaveSubTasksMatchingState('resolved', 'every');

  service.stop();
});

it('is cancellable', async () => {
  jest.useFakeTimers();
  let task: TaskConfig<any> = {
    name: 'test',
    subTasks: [
      {
        name: 'sub task 1',
        action: jest.fn().mockImplementation(() => delay(100)),
      },
      {
        name: 'sub task 2',
        action: jest.fn().mockImplementation(() => delay(100)),
      },
      {
        name: 'sub task 3',
        action: jest.fn().mockImplementation(() => delay(100)),
      },
    ],
  };

  let service = interpret(createTaskMachine(task));
  service.start();
  service.send('INIT');

  expect(service.state).toMatchState('pending.subTasks');
  expect(service.state).toHaveSubTasksMatchingState('pending', 1);

  jest.advanceTimersToNextTimer();
  await flushPromises();

  service.send('CANCEL');

  expect(service.state).toMatchState('cancelled');
  expect(service.state).toHaveSubTasksMatchingState('resolved', 1);
  expect(service.state).toHaveSubTasksMatchingState('cancelled', 2);

  expect(task.subTasks[2].action).not.toHaveBeenCalled();
});

it('moves instantly to resolved if neither action nor sub tasks are defined', () => {
  let task = {
    name: 'test',
  };

  let service = interpret(createTaskMachine(task));
  service.start();
  service.send('INIT');
  expect(service.state).toMatchState('resolved');
});

// -------------------------
// ----- EXTEND EXPECT -----
// -------------------------

expect.extend({
  toMatchState(state: State<any, any, any>, expected: string) {
    if (!(state instanceof State)) {
      return {
        message: () => `Passed in value to check is not an XState state`,
        pass: false,
      };
    }

    let pass = state.matches(expected);
    let current = state.toStrings().join(', ');

    if (pass) {
      return {
        message: () =>
          `expected state [${current}] not to to match "${expected}"`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected [${current}] to match "${expected}"`,
        pass: false,
      };
    }
  },
  toHaveSubTasksMatchingState(
    state: State<TaskContext<any>>,
    expected,
    length: number | 'every' | 'some' = 'some',
  ) {
    let pass = false;
    let matching = state.context.subTasks?.filter((task) =>
      task.state.matches(expected),
    );

    if (typeof length === 'number') {
      pass = matching != null && matching.length === length;
    } else if (length === 'every') {
      pass = matching.length === state.context.subTasks.length;
    } else {
      pass = matching.length > 0;
    }

    if (pass) {
      return {
        message: () =>
          `expected ${length} sub task(s) not to match state "${expected}", recieved ${matching.length}`,
        pass,
      };
    } else {
      return {
        message: () =>
          `expected ${length} sub task(s) to match state "${expected}", recieved ${matching.length}`,
        pass,
      };
    }
  },
});
