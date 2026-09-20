// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awsAlertOwnerErrorCodes, demoEvaluation, type Candidate, type EvaluationRequest, type EvaluationResult } from '@namayasai/backstage-plugin-jev-operations-support-common';
import { AlertInbox, ownerErrorMessages, parseAlertNotificationPage } from './AlertInbox';
import { resetLivePreferenceForTests, type EvaluateOptions } from './useLiveEvaluation';

beforeEach(() => { window.localStorage.clear(); resetLivePreferenceForTests(); });
afterEach(cleanup);

const alarmArn = 'arn:aws:cloudwatch:ap-northeast-1:123:alarm:checkout';
const context = 'Checkout requests fail for customers.';
const ownerGroups: Candidate[] = [
  { id: 'group:default/sre', entityRef: 'group:default/sre', title: 'SRE', description: 'Site reliability team' },
  { id: 'group:default/payments', entityRef: 'group:default/payments', title: 'Payments platform', description: 'Payment processing' },
];

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

async function openAlert(name = 'checkout-high-errors') {
  fireEvent.click((await screen.findAllByRole('button', { name }))[0]);
}

describe('AWS alert inbox', () => {
  it('shows severity separately from Jev impact and opens details only on selection', async () => {
    const row = rawRow();
    Object.assign(row.payload, { severity: 'high' });
    const loadNotifications = vi.fn(async () => parseAlertNotificationPage({ totalCount: 1, notifications: [row] }));
    const evaluate = vi.fn();
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={0} />);
    await screen.findByRole('button', { name: 'checkout-high-errors' });
    const table = screen.getByRole('table', { name: 'AWS alert list' });
    for (const name of ['Type', 'Severity', 'Log', 'Jev quick check']) expect(within(table).getByRole('columnheader', { name })).toBeTruthy();
    expect(within(table).getByText('high')).toBeTruthy();
    expect(within(table).getByText('Limited impact')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'AWS alert details' })).toBeNull();
    await openAlert();
    expect(screen.getByRole('article', { name: 'AWS alert details' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('article', { name: 'AWS alert details' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('article', { name: 'AWS alert details' })).toBeNull();
    expect(evaluate).not.toHaveBeenCalled();
  });

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
    await openAlert();
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
    await openAlert();
    await screen.findByText(/stored Jev result does not match the evaluation contract/);
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
  });

  it('keeps an alert whose stored details are gone, without inventing an AWS state', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, null)] });

    expect(parsed.notifications).toHaveLength(1);
    expect(parsed.skipped).toBe(0);
    expect(parsed.notifications[0].metadata).toBeUndefined();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();

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
    await openAlert();

    await screen.findByText(/stored alert details could not be read/);
    expect(screen.getAllByText('checkout-high-errors').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Re-check with Jev' })).toBeNull();
  });

  it('shows when the automatic assessment was recorded, separately from the notification time', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { evaluationStatus: 'not-evaluated', errorCode: 'evaluation-capacity-reached', result: undefined })] });
    expect(parsed.notifications[0].detailsUpdated).toBe('2026-09-19T10:00:05.000Z');
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    const status = await screen.findByText(/Jev not evaluated \(evaluation-capacity-reached\)/);
    expect(status.textContent).toContain('recorded 2026-09-19 10:00 UTC');
  });

  it('reports an alert that carries no automatic result', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { evaluationStatus: 'failed', errorCode: 'jev-busy', result: undefined })] });
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText(/Automatic evaluation failed for this alert/);
    expect(screen.getByText(/Jev evaluation failed \(jev-busy\)/)).toBeTruthy();
  });

  it('loads alerts and performs an explicit incident re-check without changing the source row', async () => {
    const loadNotifications = vi.fn().mockResolvedValue(page());
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} />);
    await openAlert();
    await screen.findAllByText('checkout-high-errors');
    expect(loadNotifications).toHaveBeenCalledWith(0, 20);
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
    expect(screen.getByText('Stored Jev result from receipt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Re-check with Jev' }));
    await screen.findByText('Manual Jev re-check (not stored)');
    expect(evaluate.mock.calls[0][0]).toEqual({ workflow: 'incident', text: context, candidates: [] });
    expect((evaluate.mock.calls[0] as unknown as [EvaluationRequest, EvaluateOptions?])[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
    expect(screen.getByText('Stored Jev result from receipt')).toBeTruthy();
  });

  it('refuses to send an over-budget multibyte context to the provider', async () => {
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { context: '障害'.repeat(9000), result: undefined, evaluationStatus: 'not-evaluated' })] });
    const evaluate = vi.fn();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} />);
    await openAlert();
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
    render(<AlertInbox autoCheck={false} loadNotifications={async () => parsed} evaluate={evaluate} />);
    await openAlert();
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
    await openAlert();
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: 'Re-check with Jev' }));
    // A parent re-render with a fresh loader replaces the list mid-re-check.
    view.rerender(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} />);
    await openAlert();
    release(demoEvaluation({ workflow: 'incident', text: context, candidates: [] }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Re-check with Jev' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Manual Jev re-check (not stored)')).toBeNull();
  });

  it('counts the rows it actually received and discards manual results when the page changes', async () => {
    const first = parseAlertNotificationPage({ totalCount: 21, notifications: [rawRow()] });
    const second = parseAlertNotificationPage({ totalCount: 21, notifications: [rawRow({ id: 'notification-21' })] });
    const loadNotifications = vi.fn(async (offset: number) => (offset === 0 ? first : second));
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={async (input: EvaluationRequest) => demoEvaluation(input)} />);
    await openAlert();
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

  it('groups alerts by the impact Jev read, and assesses an unassessed alarm when it is opened', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => twoAlerts()} evaluate={evaluate} pollMs={0} />);
    await screen.findAllByText('checkout-high-errors');
    expect(screen.getByText('Limited impact')).toBeTruthy();
    expect(screen.getByText('Not assessed by Jev')).toBeTruthy();
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await screen.findByText('Manual Jev re-check (not stored)');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0]).toMatchObject({ workflow: 'incident', text: 'Identity logins fail for customers.' });
    // The fresh assessment moves the alert out of the unassessed group.
    expect(screen.queryByText('Not assessed by Jev')).toBeNull();
  });

  it('triages a pasted report in the same place, without losing the alert list', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => page()} evaluate={evaluate} pollMs={0} liveDelayMs={5} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Triage a report' }));
    expect(screen.queryByRole('article', { name: 'AWS alert details' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'Customers report that login fails since noon.' } });
    await screen.findByText('Up to date');
    expect(evaluate.mock.calls[0][0]).toMatchObject({ workflow: 'incident', text: 'Customers report that login fails since noon.' });
    fireEvent.click(screen.getByRole('button', { name: /checkout-high-errors/ }));
    expect(screen.getByRole('article', { name: 'AWS alert details' })).toBeTruthy();
  });

  it('does not auto-assess an unassessed alert while the report pane is open', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const parsed = twoAlerts();
    // Put the unassessed alert first, so it is the default selection while the report pane opens.
    const reversed = { ...parsed, notifications: [...parsed.notifications].reverse() };
    render(<AlertInbox loadNotifications={async () => reversed} evaluate={evaluate} pollMs={0} liveDelayMs={5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' }));
    await screen.findAllByText('identity-high-errors');
    expect(evaluate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(evaluate.mock.calls[0][0]).toMatchObject({ workflow: 'incident', text: 'Identity logins fail for customers.' });
  });

  it('picks up alerts that arrive while the inbox is open', async () => {
    let pages = 0;
    const loadNotifications = vi.fn(async () => (pages++ === 0 ? page() : twoAlerts()));
    render(<AlertInbox autoCheck={false} loadNotifications={loadNotifications} evaluate={vi.fn()} pollMs={20} />);
    await screen.findAllByText('checkout-high-errors');
    await screen.findByText('identity-high-errors');
    expect(screen.getByText('New')).toBeTruthy();
  });

  it('suggests an owning team for the selected alert from the catalog teams', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const loadOwners = vi.fn(async () => [{ id: 'group:default/payments', entityRef: 'group:default/payments', title: 'Payments', description: 'Checkout and billing' }, { id: 'group:default/identity', entityRef: 'group:default/identity', title: 'Identity', description: 'Login' }]);
    render(<AlertInbox loadNotifications={async () => page()} evaluate={evaluate} loadOwners={loadOwners} pollMs={0} />);
    await openAlert();
    fireEvent.click(await screen.findByRole('button', { name: 'Suggest owning team' }));
    await screen.findByText('Suggested owner (not stored)');
    expect(evaluate.mock.calls[0][0]).toMatchObject({ workflow: 'ownership', text: context });
    expect(evaluate.mock.calls[0][0].candidates).toHaveLength(2);
  });

  it('shows an unavailable notification service as an alert', async () => {
    render(<AlertInbox loadNotifications={async () => { throw new Error('Notifications unavailable'); }} evaluate={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Notifications unavailable'));
    expect(screen.getByText('No AWS alerts were returned.')).toBeTruthy();
  });

  it('report triage sends nothing with untouched storage (Live defaults to off), until Check now', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => page()} evaluate={evaluate} pollMs={0} liveDelayMs={5} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Triage a report' }));
    expect((screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'Customers cannot log in since noon.' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(evaluate).not.toHaveBeenCalled();
    expect(screen.getByText(/Live check is off/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await screen.findByText('Up to date');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending report send when the report pane is hidden within the quiet period', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => page()} evaluate={evaluate} pollMs={0} liveDelayMs={30} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Triage a report' }));
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'Customers cannot log in since noon.' } });
    // Selecting an alert closes the report pane before the quiet period elapses.
    fireEvent.click(screen.getByRole('button', { name: /checkout-high-errors/ }));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not auto-assess the same alert again after a refresh', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const loadNotifications = vi.fn(async () => twoAlerts());
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={0} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('does not auto-assess an alert while Live is off (the default, untouched)', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => twoAlerts()} evaluate={evaluate} pollMs={0} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' }));
    expect((screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not auto-assess an alert that was clicked while Live was off, even once Live is turned on afterwards', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => twoAlerts()} evaluate={evaluate} pollMs={0} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' }));
    // Live is off by default, untouched; the click itself expressed no intent. The row's own
    // click closes the report pane, so the checkbox is not on screen while this happens.
    expect((screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Live check' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not auto-assess an alert that was clicked while this view was inactive, even after it becomes active', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const loadNotifications = vi.fn(async () => twoAlerts());
    const view = render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={0} active={false} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    view.rerender(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={0} active />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('auto-assesses an unassessed alert opened after the reader turns Live on', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => twoAlerts()} evaluate={evaluate} pollMs={0} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Live check' }));
    fireEvent.click(screen.getByRole('button', { name: 'Triage a report' })); // close the report pane
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    expect(evaluate.mock.calls[0][0]).toMatchObject({ workflow: 'incident', text: 'Identity logins fail for customers.' });
  });

  it('points the reader at the manual re-check when the selected alert has no stored result and Live is off', async () => {
    const parsed = twoAlerts();
    // The unassessed alert first, so it is selected on the untouched (Live off) default.
    const reversed = { ...parsed, notifications: [...parsed.notifications].reverse() };
    render(<AlertInbox loadNotifications={async () => reversed} evaluate={vi.fn()} pollMs={0} />);
    await openAlert('identity-high-errors');
    expect(screen.getByText(/No automatic Jev result is stored on this alert/)).toBeTruthy();
    expect(screen.getByText('Choose Re-check with Jev to assess it now.')).toBeTruthy();
  });

  it('assesses an unassessed alert once when it is clicked under normal conditions', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => twoAlerts()} evaluate={evaluate} pollMs={0} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('does not auto-assess or poll while inactive', async () => {
    window.localStorage.setItem('jev-operations-support.live', 'on');
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    const loadNotifications = vi.fn(async () => twoAlerts());
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={20} active={false} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(evaluate).not.toHaveBeenCalled();
    expect(loadNotifications).toHaveBeenCalledTimes(1);
  });

  it('keeps a selected alert on screen with a caption when a background poll drops it, and sends nothing', async () => {
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    let calls = 0;
    // pollMs is long enough that the background refresh only fires after the alert is selected.
    const loadNotifications = vi.fn(async () => (calls++ === 0 ? twoAlerts() : page()));
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={evaluate} pollMs={300} autoCheck={false} />);
    await screen.findAllByText('checkout-high-errors');
    fireEvent.click(screen.getByRole('button', { name: /identity-high-errors/ }));
    await screen.findByDisplayValue('Identity logins fail for customers.');
    await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await screen.findByText(/This alert is no longer on this page of the inbox/);
    expect(screen.getByText('identity-high-errors')).toBeTruthy();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a successful background poll restores the list without opening details', async () => {
    let calls = 0;
    const loadNotifications = vi.fn(async () => { calls++; if (calls === 1) throw new Error('AWS alerts could not be loaded.'); return page(); });
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={vi.fn()} pollMs={20} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('AWS alerts could not be loaded.'));
    await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByRole('article', { name: 'AWS alert details' })).toBeNull();
    await openAlert();
    expect(screen.getByRole('article', { name: 'AWS alert details' })).toBeTruthy();
    expect(screen.getAllByText('checkout-high-errors').length).toBeGreaterThan(0);
  });

  it('stops polling for good after a load fails with AlertsUnavailableError', async () => {
    class AlertsUnavailableError extends Error {
      constructor(message: string) { super(message); this.name = 'AlertsUnavailableError'; }
    }
    const loadNotifications = vi.fn(async () => { throw new AlertsUnavailableError('AWS alerts are unavailable.'); });
    render(<AlertInbox loadNotifications={loadNotifications} evaluate={vi.fn()} pollMs={20} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('AWS alerts are unavailable.'));
    const callsAfterInitial = loadNotifications.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(loadNotifications).toHaveBeenCalledTimes(callsAfterInitial);
  });

  it('exposes the report triage pane\'s "off" explanation to assistive tech, not just a title attribute', async () => {
    render(<AlertInbox loadNotifications={async () => page()} evaluate={vi.fn()} live={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Triage a report' }));
    const toggle = screen.getByRole('checkbox', { name: 'Live check' }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    // The explanation must be reachable by keyboard/screen reader, not just a `title` attribute.
    const describedById = toggle.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById!)?.textContent).toMatch(/Automatic checks are turned off for this view/);
  });
});

describe('AWS alert inbox: owner suggestion made at receipt', () => {
  function withOwner(overrides: Record<string, unknown> = {}) {
    return parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, {
      ownerStatus: 'evaluated',
      ownerResult: demoEvaluation({ workflow: 'ownership', text: context, candidates: ownerGroups }),
      ...overrides,
    })] });
  }

  it('shows an "Owner: <title>" chip in the row when the stored suggestion is a confident pass', async () => {
    const parsed = withOwner();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    // demoEvaluation's fixture selects the first candidate ("c0") with high confidence (a pass).
    await screen.findByText(`Owner: ${ownerGroups[0].title}`);
  });

  it('shows no owner chip in the row when the stored suggestion needs review', async () => {
    const reviewResult: EvaluationResult = {
      workflow: 'ownership', model: 'jev-1.13.0', evaluatedAt: '2026-09-19T10:00:00.000Z', mode: 'live', needsReview: true,
      findings: [{ id: 'recommendation', title: 'Suggested responsible team', statement: 'x', status: 'review', value: 'none', kind: 'choice', confidence: 0.4, guidance: 'Confirm the fit before proceeding.' }],
    };
    const parsed = withOwner({ ownerResult: reviewResult });
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await screen.findAllByText('checkout-high-errors');
    expect(screen.queryByText(/^Owner:/)).toBeNull();
  });

  it('renders a stored owner suggestion in the detail pane, after the incident result', async () => {
    const parsed = withOwner();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText('Stored Jev result from receipt');
    await screen.findByText('Suggested owner from receipt');
    expect(screen.getAllByText(/SRE/).length).toBeGreaterThan(0);
  });

  it('drops an owner result that fails the evaluation contract or is not the ownership workflow, without hiding the alert', async () => {
    const wrongWorkflow = demoEvaluation({ workflow: 'incident', text: context, candidates: [] });
    const parsed = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { ownerStatus: 'evaluated', ownerResult: wrongWorkflow })] });
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findAllByText('checkout-high-errors');
    expect(screen.getByText('AWS state: ALARM')).toBeTruthy();
    await screen.findByText(/stored owner suggestion does not match the evaluation contract/);
    expect(screen.queryByText('Suggested owner from receipt')).toBeNull();
  });

  it('explains a failed or not-evaluated stored owner status in one sentence', async () => {
    const notEvaluated = parseAlertNotificationPage({ totalCount: 1, notifications: [rawRow({}, { ownerStatus: 'not-evaluated', ownerErrorCode: 'no-catalog-groups' })] });
    render(<AlertInbox loadNotifications={async () => notEvaluated} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText(/No catalog Group entities were available/);
  });

  it('omits the owner section entirely when no owner fields are stored (feature disabled)', async () => {
    const parsed = page();
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText('Stored Jev result from receipt');
    expect(screen.queryByText('Suggested owner from receipt')).toBeNull();
    expect(screen.queryByText(/^No automatic owner suggestion/)).toBeNull();
  });

  it('shows "Suggest owning team" with no stored result, and "Re-suggest owning team" once one is stored', async () => {
    const noOwner = page();
    const withStoredOwner = withOwner();
    const loadOwners = vi.fn(async () => ownerGroups);
    render(<AlertInbox loadNotifications={async () => noOwner} evaluate={vi.fn()} loadOwners={loadOwners} pollMs={0} />);
    await openAlert();
    await screen.findByRole('button', { name: 'Suggest owning team' });

    cleanup();
    render(<AlertInbox loadNotifications={async () => withStoredOwner} evaluate={vi.fn()} loadOwners={loadOwners} pollMs={0} />);
    await openAlert();
    await screen.findByRole('button', { name: 'Re-suggest owning team' });
  });

  it('keeps the manual "Suggested owner (not stored)" section and label separate from a stored owner suggestion', async () => {
    const parsed = withOwner();
    const loadOwners = vi.fn(async () => ownerGroups);
    const evaluate = vi.fn(async (input: EvaluationRequest) => demoEvaluation(input));
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={evaluate} loadOwners={loadOwners} pollMs={0} />);
    await openAlert();
    await screen.findByText('Suggested owner from receipt');

    fireEvent.click(await screen.findByRole('button', { name: 'Re-suggest owning team' }));
    await screen.findByText('Suggested owner (not stored)');
    expect(evaluate.mock.calls[0][0]).toMatchObject({ workflow: 'ownership', text: context });
    // The stored section is unaffected by the manual, unsaved re-suggestion.
    expect(screen.getByText('Suggested owner from receipt')).toBeTruthy();
  });

  it('labels a runner-up candidate from the stored shortlist instead of a raw c0/c1 key', async () => {
    const parsed = withOwner({ ownerCandidates: ownerGroups.map(candidate => ({ id: candidate.id, title: candidate.title })) });
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText('Suggested owner from receipt');
    const section = within(screen.getByRole('group', { name: 'Suggested owner from receipt' }));
    // A confident "pass" choice with a resolvable candidate link is expanded by default.
    fireEvent.click(section.getByText('Probability distribution'));
    // Both candidates from the stored shortlist are labelled by title in the breakdown
    // (the chosen candidate's title also appears as the finding's own value, hence "any").
    expect(section.getAllByText(ownerGroups[0].title).length).toBeGreaterThan(0);
    expect(section.getAllByText(ownerGroups[1].title).length).toBeGreaterThan(0);
    expect(section.queryByText(/^c\d+$/)).toBeNull();
  });

  it('falls back to "Candidate N" instead of a raw c0/c1 key when no stored shortlist is available', async () => {
    const parsed = withOwner(); // no ownerCandidates stored
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText('Suggested owner from receipt');
    const section = within(screen.getByRole('group', { name: 'Suggested owner from receipt' }));
    fireEvent.click(section.getByText('Probability distribution'));
    expect(section.getByText('Candidate 1')).toBeTruthy();
    expect(section.getByText('Candidate 2')).toBeTruthy();
  });

  it('notes when the stored shortlist was shortened to fit the evaluation budget', async () => {
    const parsed = withOwner({ ownerShortened: true });
    render(<AlertInbox loadNotifications={async () => parsed} evaluate={vi.fn()} />);
    await openAlert();
    await screen.findByText(/shortened team descriptions were used/);
  });

  it('maps every owner error code the backend can store to a readable sentence', () => {
    // `awsAlertOwnerErrorCodes` is the same source of truth the AWS notifications module
    // uses (it re-exports this from the common package): if a code is added there and
    // this map is not updated, this test fails rather than silently showing nothing.
    for (const code of awsAlertOwnerErrorCodes) {
      expect(ownerErrorMessages[code], `missing a message for owner error code "${code}"`).toBeTruthy();
    }
  });
});
