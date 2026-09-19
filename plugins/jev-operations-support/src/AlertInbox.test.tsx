// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoEvaluation, type EvaluationRequest, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { AlertInbox, parseAlertNotificationPage } from './AlertInbox';

afterEach(cleanup);

const alarmArn = 'arn:aws:cloudwatch:ap-northeast-1:123:alarm:checkout';
const context = 'Checkout requests fail for customers.';

/** The shape the backend returns: a native notification row with details restored. */
function rawRow(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> | null = {}) {
  return {
    id: 'notification-1',
    created: '2026-09-19T10:00:00.000Z',
    origin: 'plugin:jev-operations-support',
    payload: {
      topic: 'jev-aws-alerts',
      title: 'checkout-high-errors',
      description: 'HTTP 500 rate exceeded threshold',
      ...(metadata ? { metadata: { jevOperationsSupport: {
        source: 'aws-cloudwatch', context, awsState: 'ALARM', alarmArn, region: 'ap-northeast-1', evaluationStatus: 'evaluated',
        result: demoEvaluation({ workflow: 'incident', text: context, candidates: [] }),
        snsMessageId: 'sns-1', topicArn: 'arn:aws:sns:ap-northeast-1:123:alerts', updatedAt: '2026-09-19T10:00:05.000Z',
        ...metadata,
      } } } : {}),
    },
    ...overrides,
  };
}

function rawPage() {
  return { totalCount: 1, notifications: [rawRow()] };
}

function page() {
  return parseAlertNotificationPage(rawPage());
}

function twoAlerts() {
  const second = rawRow({ id: 'notification-2' }, { context: 'Identity logins fail for customers.', result: undefined, evaluationStatus: 'not-evaluated' });
  second.payload.title = 'identity-high-errors';
  return parseAlertNotificationPage({ totalCount: 2, notifications: [rawRow(), second] });
}

describe('AWS alert inbox', () => {
  it('drops malformed rows without rejecting valid notifications', () => {
    const parsed = parseAlertNotificationPage({ totalCount: 2, notifications: [rawRow(), { payload: { topic: 'other' } }] });
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it('reads the standard Notifications timestamps and shows a concise receipt time', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({ updated: '2026-09-19T10:00:04.000Z' })] });
    expect(parsed.notifications[0].created).toBe('2026-09-19T10:00:00.000Z');
    expect(parsed.notifications[0].updated).toBe('2026-09-19T10:00:04.000Z');
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await screen.findAllByText(/2026-09-19 10:00 UTC/);
    expect(screen.getByText(/updated/).textContent).toContain('2026-09-19 10:00 UTC');
  });

  it('keeps an alarm that reports no usable timestamp', async () => {
    const parsed = parseAlertNotificationPage({
      totalCount: 2,
      notifications: [rawRow({ created: undefined }), rawRow({ id: 'notification-2', created: 'not-a-date' })],
    });
    expect(parsed.notifications.map(notification => notification.created)).toEqual([undefined, undefined]);
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    expect(await screen.findAllByText(/Received time not reported/)).toHaveLength(2);
  });

  it('keeps an alarm whose region the backend could not report', () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { region: '' })] });
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.notifications[0].metadata?.region).toBe('');
  });

  it('keeps the alarm visible when its stored result breaks the evaluation contract', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { result: { model: 'x', findings: 'not-an-array' } })] });
    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.notifications[0].resultUnreadable).toBe(true);
    expect(parsed.notifications[0].metadata?.result).toBeUndefined();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await screen.findByText(/stored Jev result does not match the evaluation contract/);
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
  });

  it('keeps an alert whose stored details are gone, without inventing an AWS state', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, null)] });

    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.notifications[0].metadata).toBeUndefined();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);

    await screen.findAllByText('checkout-high-errors');
    expect(screen.getAllByText(/HTTP 500 rate exceeded threshold/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2026-09-19 10:00 UTC/).length).toBeGreaterThan(0);
    await screen.findByText(/stored alert details are unavailable/);
    // No AWS state, no context, and no re-check are offered without the stored details.
    expect(screen.queryByText(/AWS state:/)).toBeNull();
    expect(screen.queryByLabelText('Context preview')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-check with Jev' })).toBeNull();
  });

  it('keeps an alert whose stored details do not match the contract', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { awsState: 'PROBABLY', context: undefined })] });

    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.notifications[0].detailsUnreadable).toBe(true);
    expect(parsed.notifications[0].metadata).toBeUndefined();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);

    await screen.findByText(/stored alert details could not be read/);
    expect(screen.getAllByText('checkout-high-errors').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Re-check with Jev' })).toBeNull();
  });

  it('shows when the automatic assessment was recorded, separately from the notification time', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { evaluationStatus: 'not-evaluated', errorCode: 'evaluation-capacity-reached', result: undefined })] });
    expect(parsed.notifications[0].detailsUpdated).toBe('2026-09-19T10:00:05.000Z');
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    const status = await screen.findByText(/Jev not evaluated \(evaluation-capacity-reached\)/);
    expect(status.textContent).toContain('recorded 2026-09-19 10:00 UTC');
  });

  it('reports an alert that carries no automatic result', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { evaluationStatus: 'failed', errorCode: 'jev-busy', result: undefined })] });
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await screen.findByText(/Automatic evaluation failed for this alert/);
    expect(screen.getByText(/Jev evaluation failed \(jev-busy\)/)).toBeTruthy();
  });

  it('loads alerts and performs an explicit incident re-check without changing the source row', async () => {
    const loadNotifications = vi.fn().mockResolvedValue(page());
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} />);
    await screen.findAllByText('checkout-high-errors');
    expect(loadNotifications).toHaveBeenCalledWith(0, 20);
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
    expect(screen.getByText('Stored Jev result from receipt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check with Jev' }));
    await screen.findByText('Manual Jev re-check (not stored)');
    expect(evaluate).toHaveBeenCalledWith({ workflow: 'incident', text: context, candidates: [] });
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
    expect(screen.getByText('Stored Jev result from receipt')).toBeTruthy();
  });

  it('refuses to send an over-budget multibyte context to the provider', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { context: '障害'.repeat(9000), result: undefined, evaluationStatus: 'not-evaluated' })] });
    const evaluate = vi.fn();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Re-check with Jev' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('cannot be evaluated'));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('keeps a manual re-check and its failure attached to the alert that produced it', async () => {
    const parsed = twoAlerts();
    let settle: (outcome: EvaluationResult | Error) => void = () => {};
    const evaluate = vi.fn(() => new Promise<EvaluationResult>((resolve, reject) => {
      settle = outcome => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
    }));
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: 'Re-check with Jev' }));
    // Move to the other alert while the re-check of the first one is still running.
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await screen.findByDisplayValue('Identity logins fail for customers.');
    settle(new Error('Jev is busy'));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Re-check with Jev' }) as HTMLButtonElement).disabled).toBe(false));
    // The failure belongs to the alert that was re-checked, not to the one on screen.
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /checkout-high-errors/ }));
    expect(screen.getByRole('alert').textContent).toContain('Jev is busy');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('discards a re-check that resolves after the list was reloaded', async () => {
    const parsed = twoAlerts();
    let release: (result: EvaluationResult) => void = () => {};
    const evaluate = vi.fn(() => new Promise<EvaluationResult>(resolve => { release = resolve; }));
    const view = render(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: 'Re-check with Jev' }));
    // A parent re-render with a fresh loader replaces the list mid-re-check.
    view.rerender(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} />);
    release(demoEvaluation({ workflow: 'incident', text: context, candidates: [] }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Re-check with Jev' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Manual Jev re-check (not stored)')).toBeNull();
  });

  it('counts the rows it actually received and discards manual results when the page changes', async () => {
    const first = parseAlertNotificationPage({ totalCount: 21, notifications: [rawRow()] });
    const second = parseAlertNotificationPage({ totalCount: 21, notifications: [rawRow({ id: 'notification-21' })] });
    const loadNotifications = vi.fn(async (offset: number) => (offset === 0 ? first : second));
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={async (input: EvaluationRequest) => demoEvaluation(input)} />);
    await screen.findAllByText('checkout-high-errors');
    expect(screen.getByText('1–1 of 21')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check with Jev' }));
    await screen.findByText('Manual Jev re-check (not stored)');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(loadNotifications).toHaveBeenLastCalledWith(20, 20));
    await screen.findByText('21–21 of 21');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(loadNotifications).toHaveBeenLastCalledWith(0, 20));
    await screen.findByText('1–1 of 21');
    expect(screen.queryByText('Manual Jev re-check (not stored)')).toBeNull();
  });

  it('shows an unavailable notification service as an alert', async () => {
    render(<AlertInbox loadNotifications={async () => { throw new Error('Notifications unavailable'); }} evaluate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Notifications unavailable'));
    expect(screen.getByText('No AWS alerts were returned.')).toBeTruthy();
  });
});
