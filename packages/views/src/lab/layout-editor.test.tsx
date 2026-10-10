import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';
import type { SceneNode } from '@labos-threejs/sdk';
import {
  PlacementEditor,
  withPlacement,
  hasInvalidCoordinateText,
  type LayoutDraft,
} from './layout-editor';

const original: SceneNode = {
  id: 'node-one',
  lab_id: 'lab-one',
  entity_id: 'entity-one',
  representation_id: null,
  placement: {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  },
};

function Editor() {
  const [node, setNode] = useState(original);
  return (
    <>
      <PlacementEditor
        node={node}
        disabled={false}
        onChange={(placement) => setNode({ ...node, placement })}
      />
      <output aria-label="Valid X placement">
        {node.placement.position[0]}
      </output>
      <output aria-label="Valid X scale">{node.placement.scale[0]}</output>
    </>
  );
}

test('unfinished negative decimal text does not replace valid Placement', async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const x = screen.getByLabelText<HTMLInputElement>('X (m)');
  await user.clear(x);
  expect(x.value).toBe('');
  expect(screen.getByLabelText('Valid X placement')).toHaveTextContent('0');
  await user.type(x, '-');
  expect(x.value).toBe('-');
  expect(screen.getByLabelText('Valid X placement')).toHaveTextContent('0');
  await user.type(x, '.');
  expect(x.value).toBe('-.');
  expect(screen.getByLabelText('Valid X placement')).toHaveTextContent('0');
  await user.type(x, '25');
  expect(x.value).toBe('-.25');
  expect(screen.getByLabelText('Valid X placement')).toHaveTextContent('-0.25');
});

test('an invalid scale retains its text and explains the legal range after blur', async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const scale = screen.getByLabelText<HTMLInputElement>('Sx');
  await user.clear(scale);
  await user.type(scale, '0');
  expect(scale.value).toBe('0');
  expect(screen.getByLabelText('Valid X scale')).toHaveTextContent('1');
  await user.tab();
  expect(scale.value).toBe('0');
  expect(scale).toHaveAttribute('aria-invalid', 'true');
  expect(scale).toHaveAccessibleDescription('0.001 ≤ Sx ≤ 1000');
  await user.clear(scale);
  await user.type(scale, '0.25');
  expect(screen.getByLabelText('Valid X scale')).toHaveTextContent('0.25');
});

test('a restored unfinished coordinate can continue without changing its valid Placement', async () => {
  const user = userEvent.setup();
  function RestoredEditor() {
    const [node, setNode] = useState(original);
    const [coordinateText, setCoordinateText] = useState({
      'node-one-position-X': '-.',
    } as Record<string, string>);
    const textProps = {
      coordinateText,
      onTextChange(id: string, text: string | null) {
        setCoordinateText((previous) => {
          const next = { ...previous };
          if (text === null) delete next[id];
          else next[id] = text;
          return next;
        });
      },
    };
    return (
      <>
        <PlacementEditor
          {...textProps}
          node={node}
          disabled={false}
          onChange={(placement) => setNode({ ...node, placement })}
        />
        <output aria-label="Restored valid X">
          {node.placement.position[0]}
        </output>
      </>
    );
  }
  render(<RestoredEditor />);
  const x = screen.getByLabelText<HTMLInputElement>('X (m)');
  expect(x.value).toBe('-.');
  expect(screen.getByLabelText('Restored valid X')).toHaveTextContent('0');
  await user.type(x, '25');
  expect(x.value).toBe('-.25');
  expect(screen.getByLabelText('Restored valid X')).toHaveTextContent('-0.25');
});

test('moving X replaces its numeric spelling while unfinished Y still blocks save', async () => {
  const user = userEvent.setup();
  function PointerEditor() {
    const [draft, setDraft] = useState<LayoutDraft>({
      version: 3,
      nodes: [original],
      baseNodes: [original],
      relationships: [],
      baseRelationships: [],
      coordinateText: {
        'node-one-position-X': '0.00',
        'node-one-position-Y': '-',
      },
    });
    return (
      <>
        <PlacementEditor
          node={draft.nodes[0]}
          disabled={false}
          coordinateText={draft.coordinateText}
          onTextChange={() => {}}
          onChange={() => {}}
        />
        <button
          onClick={() =>
            setDraft(
              withPlacement(draft, original.id, {
                ...original.placement,
                position: [2, 0, 0],
              }),
            )
          }
        >
          Move X
        </button>
        <button disabled={hasInvalidCoordinateText(draft)}>Save</button>
      </>
    );
  }
  render(<PointerEditor />);
  expect(screen.getByLabelText<HTMLInputElement>('X (m)').value).toBe('0.00');
  await user.click(screen.getByRole('button', { name: 'Move X' }));
  expect(screen.getByLabelText<HTMLInputElement>('X (m)').value).toBe('2');
  expect(screen.getByLabelText<HTMLInputElement>('Y (m)').value).toBe('-');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('arrow keys step valid coordinates by 0.01 while preserving unfinished text and limits', async () => {
  const user = userEvent.setup();
  render(<Editor />);
  const x = screen.getByLabelText<HTMLInputElement>('X (m)');
  await user.clear(x);
  await user.type(x, '7');
  await user.keyboard('{ArrowUp}');
  expect(x.value).toBe('7.01');
  expect(screen.getByLabelText('Valid X placement')).toHaveTextContent('7.01');
  await user.keyboard('{ArrowDown}');
  expect(x.value).toBe('7');
  await user.clear(x);
  await user.type(x, '-.');
  await user.keyboard('{ArrowUp}{ArrowDown}');
  expect(x.value).toBe('-.');
  expect(screen.getByLabelText('Valid X placement')).toHaveTextContent('7');
  await user.clear(x);
  await user.type(x, '10000');
  await user.keyboard('{ArrowUp}');
  expect(x.value).toBe('10000');
  const scale = screen.getByLabelText<HTMLInputElement>('Sx');
  await user.clear(scale);
  await user.type(scale, '0.001');
  await user.keyboard('{ArrowDown}');
  expect(scale.value).toBe('0.001');
  await user.keyboard('{ArrowUp}');
  expect(scale.value).toBe('0.011');
  expect(screen.getByLabelText('Valid X scale')).toHaveTextContent('0.011');
});
