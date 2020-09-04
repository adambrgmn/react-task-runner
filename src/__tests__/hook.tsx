import React from 'react';
import { render, fireEvent, screen, act } from '@testing-library/react';
import { useTaskMachine, TaskConfig, UseTaskMachineState } from '..';

let delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

let TaskPreview: React.FC<{ taskState: UseTaskMachineState<any> }> = ({
  taskState,
}) => {
  let stateValue: string;
  switch (true) {
    case taskState.matches('idle'):
      stateValue = 'IDLE';
      break;
    case taskState.matches('pending'):
      stateValue = 'PENDING';
      break;
    case taskState.matches('resolved'):
      stateValue = 'RESOLVED';
      break;
    case taskState.matches('rejected'):
      stateValue = 'REJECTED';
      break;
  }

  return (
    <div>
      <p>
        Name: {taskState.name} ({stateValue})
      </p>
      {taskState.subTasks && (
        <ul>
          {taskState.subTasks.map((subTask) => (
            <li key={subTask.name}>
              <TaskPreview taskState={subTask} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

let TaskComponent: React.FC<{
  task: TaskConfig<any>;
  renderContext?: React.FC<{ context: any }>;
}> = ({ task, renderContext: Context }) => {
  const [state, { init, cancel }] = useTaskMachine(task);

  return (
    <div>
      <button onClick={init} disabled={!state.matches('idle')}>
        init
      </button>
      <button onClick={cancel} disabled={state.done}>
        cancel
      </button>
      <TaskPreview taskState={state} />
      {Context && <Context context={state.context} />}
    </div>
  );
};

it('should handle task states', async () => {
  let task: TaskConfig<any> = {
    name: 'test',
    subTasks: [
      { name: 'sub task 1', action: jest.fn() },
      { name: 'sub task 2', action: jest.fn() },
      { name: 'sub task 3', action: jest.fn() },
    ],
  };

  render(<TaskComponent task={task} />);

  let btn = screen.getByRole('button', { name: 'init' });
  expect(screen.getByText('Name: test (IDLE)')).toBeInTheDocument();

  fireEvent.click(btn);

  expect(await screen.findByText('Name: test (RESOLVED)')).toBeInTheDocument();
});

it('processes tasks in sync', async () => {
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

  render(<TaskComponent task={task} />);

  fireEvent.click(screen.getByRole('button', { name: 'init' }));

  for (let i = 0; i < 3; i++) {
    expect(screen.queryAllByText(/PENDING/)).toHaveLength(2);
    act(() => jest.advanceTimersToNextTimer());
    expect(
      await screen.findByText(`Name: sub task ${i + 1} (RESOLVED)`),
    ).toBeInTheDocument();
  }

  expect(screen.getByText('Name: test (RESOLVED)')).toBeInTheDocument();
});

it('gives back context', async () => {
  let task: TaskConfig<{ alphabet?: string }> = {
    name: 'test',
    subTasks: [
      {
        name: 'sub task 1',
        action: (context) => {
          context.alphabet = (context.alphabet ?? '') + 'a';
          return delay(0);
        },
      },
      {
        name: 'sub task 2',
        action: (context) => {
          context.alphabet = (context.alphabet ?? '') + 'b';
          return delay(0);
        },
      },
      {
        name: 'sub task 3',
        action: jest.fn().mockImplementation((context) => {
          context.alphabet = (context.alphabet ?? '') + 'c';
          return delay(0);
        }),
      },
    ],
  };

  let RenderContext: React.FC<{ context: any }> = ({ context }) => {
    return <p>Alphabet: {context.alphabet}</p>;
  };

  render(<TaskComponent task={task} renderContext={RenderContext} />);

  fireEvent.click(screen.getByRole('button', { name: 'init' }));
  expect(await screen.findByText('Alphabet: a')).toBeInTheDocument();
  expect(await screen.findByText('Alphabet: ab')).toBeInTheDocument();
  expect(await screen.findByText('Alphabet: abc')).toBeInTheDocument();
});

it('is possible to append a task after ');
