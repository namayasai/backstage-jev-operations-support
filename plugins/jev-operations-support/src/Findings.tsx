import { useEffect, useId, useState, type ReactNode } from 'react';
import { Box, Chip, Collapse, IconButton, LinearProgress, Typography, makeStyles } from '@material-ui/core';
import { Skeleton } from '@material-ui/lab';
import { ExpandMoreIcon } from './icons';
import { buildEvaluation, findingStatusLabels, formatFindingValue, type Candidate, type Finding } from '@namayasai/backstage-plugin-jev-operations-support-common';

type Status = Finding['status'];
type HeadingLevel = 'h3' | 'h4';

/** What each triage label means, in the words Jev was given; a bare "limited" explains nothing. */
const choiceMeanings: Record<string, Record<string, string>> = Object.fromEntries(
  buildEvaluation({ workflow: 'incident', text: '', candidates: [] }).checks.map(check => [check.id, check.question.type === 'choice' ? check.question.criteria : {}]),
);
export const statusLabels = findingStatusLabels;
const statusOrder: Status[] = ['attention', 'review', 'pass'];

const useStyles = makeStyles(theme => {
  const tone = (status: Status) => status === 'pass' ? theme.palette.success.main : status === 'attention' ? theme.palette.warning.main : theme.palette.info.main;
  const rule = (status: Status) => ({ borderLeft: `4px solid ${tone(status)}` });
  const chip = (status: Status) => ({ borderColor: tone(status), color: theme.palette.text.primary, fontWeight: 600 });
  return {
    list: { display: 'grid', gap: theme.spacing(1), transition: 'opacity .2s' },
    stale: { opacity: 0.45 },
    check: { border: `1px solid ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, overflow: 'hidden' },
    pass: rule('pass'), attention: rule('attention'), review: rule('review'),
    passChip: chip('pass'), attentionChip: chip('attention'), reviewChip: chip('review'),
    header: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: theme.spacing(0.5, 1.5), alignItems: 'start', padding: theme.spacing(1.5, 2), cursor: 'pointer' },
    headerText: { display: 'grid', gap: theme.spacing(0.5) },
    expand: { transition: 'transform .2s' },
    expandOpen: { transform: 'rotate(180deg)' },
    value: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontWeight: 600, overflowWrap: 'anywhere' },
    details: { display: 'grid', gap: theme.spacing(1.25), padding: theme.spacing(0, 2, 2) },
    meter: { height: 6, borderRadius: 3 },
    distribution: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px auto', gap: theme.spacing(0.5, 1.5), alignItems: 'center', margin: 0 },
    pending: { border: `1px solid ${theme.palette.divider}`, borderLeft: `4px solid ${theme.palette.divider}`, borderRadius: theme.shape.borderRadius, padding: theme.spacing(1.5, 2) },
    counts: { display: 'flex', gap: theme.spacing(1), flexWrap: 'wrap' },
  };
});

export { formatFindingValue };

/** Open by default wherever the reader has something to do: a signal that is not clear, or a recommendation to follow. */
function defaultOpen(finding: Finding): boolean {
  return finding.status !== 'pass' || (finding.kind === 'choice' && Boolean(finding.candidate?.entityRef));
}

/** How many findings landed in each status, most urgent first. */
export function FindingCounts({ findings }: { findings: Finding[] }) {
  const classes = useStyles();
  return <div className={classes.counts} role="group" aria-label="Result summary">
    {statusOrder.map(status => {
      const count = findings.filter(finding => finding.status === status).length;
      return <Chip key={status} size="small" variant="outlined" disabled={!count} className={classes[`${status}Chip`]} label={`${count} ${statusLabels[status].toLocaleLowerCase('en-US')}`} />;
    })}
  </div>;
}

function FindingRow({ finding, candidates, renderCandidateLink, headingLevel = 'h3' }: { finding: Finding; candidates: Pick<Candidate, 'id' | 'title'>[]; renderCandidateLink?: (candidate: Candidate) => ReactNode; headingLevel?: HeadingLevel }) {
  const classes = useStyles();
  // The reader can override the default, but a later result for the same finding starts fresh.
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  useEffect(() => { setOverride(undefined); }, [finding.status]);
  const open = override ?? defaultOpen(finding);
  function toggle() { setOverride(!open); }
  const meaning = finding.kind === 'choice' && !finding.candidate ? choiceMeanings[finding.id]?.[String(finding.value)] : undefined;
  const ratio = finding.kind === 'choice' ? finding.confidence ?? 0 : Number(finding.value) / (finding.kind === 'score' ? 3 : 1);
  // Two result panes (e.g. the manual re-check and the stored result) can render the same
  // finding id at once; React's own id is unique per mounted row, so `aria-controls` never collides.
  const detailsId = useId();
  return <div className={`${classes.check} ${classes[finding.status]}`}>
    {/* The header may also toggle on click, but the icon button below is the only accessible control. */}
    <div className={classes.header} onClick={toggle}>
      <div className={classes.headerText}>
        <Typography variant="subtitle2" component={headingLevel}>{finding.title}</Typography>
        <Typography variant="caption" color="textSecondary" component="p">{finding.statement}</Typography>
        <Typography variant="body1" className={`${classes.value} jev-value`}>{formatFindingValue(finding)}</Typography>
        {meaning && <Typography variant="body2">{meaning}</Typography>}
      </div>
      <Chip size="small" variant="outlined" className={classes[`${finding.status}Chip`]} label={statusLabels[finding.status]} />
      <IconButton size="small" aria-expanded={open} aria-controls={detailsId} aria-label={`${open ? 'Hide' : 'Show'} details for ${finding.title}`} onClick={event => { event.stopPropagation(); toggle(); }}>
        <ExpandMoreIcon fontSize="small" className={`${classes.expand} ${open ? classes.expandOpen : ''}`} />
      </IconButton>
    </div>
    <Collapse in={open}>
      <div id={detailsId} className={classes.details}>
        <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, ratio * 100))} className={classes.meter} aria-hidden />
        <Typography variant="caption" color="textSecondary">{finding.kind === 'noul' ? 'Estimated probability that this statement is supported by the supplied context.' : `Model confidence: ${Math.round((finding.confidence ?? 0) * 100)}%. Confidence is not a guarantee of correctness.`}</Typography>
        <Typography variant="body2"><strong>Next step:</strong> {finding.guidance}</Typography>
        {finding.candidate?.entityRef && <Typography variant="body2">{renderCandidateLink ? renderCandidateLink(finding.candidate) : <>Catalog entity: <code>{finding.candidate.entityRef}</code></>}</Typography>}
        {finding.probabilities && <details><Typography variant="caption" color="textSecondary" component="summary" style={{ cursor: 'pointer' }}>Probability distribution</Typography><dl className={classes.distribution} style={{ marginTop: 8 }}>
          {Object.entries(finding.probabilities).map(([key, value]) => <Box key={key} display="contents">
            {/* A raw `c0`/`c1` key is never shown: without a matching candidate title (the
                candidate list was not supplied, or is shorter than this index), the runner-up
                is still labelled plainly rather than with the schema's own internal key. */}
            <Typography variant="caption" component="dt">{finding.levels?.[Number(key)] ?? (/^c\d+$/.test(key) ? candidates[Number(key.slice(1))]?.title ?? `Candidate ${Number(key.slice(1)) + 1}` : key)}</Typography>
            <LinearProgress variant="determinate" value={value * 100} className={classes.meter} aria-hidden />
            <Typography variant="caption" component="dd" style={{ margin: 0 }}>{(value * 100).toFixed(1)}%</Typography>
          </Box>)}
        </dl></details>}
      </div>
    </Collapse>
  </div>;
}

export interface FindingListProps {
  findings: Finding[];
  /** Only `id`/`title` are read (to label a runner-up candidate in the probability
   * breakdown), so a titles-only stored shortlist can be passed as-is, without its
   * original descriptions. */
  candidates?: Pick<Candidate, 'id' | 'title'>[];
  renderCandidateLink?: (candidate: Candidate) => ReactNode;
  /** The findings describe an earlier version of the input. */
  stale?: boolean;
  /** The heading level for each finding's title, so it nests under the surrounding card's own headings. */
  headingLevel?: HeadingLevel;
}

export function FindingList({ findings, candidates = [], renderCandidateLink, stale = false, headingLevel = 'h3' }: FindingListProps) {
  const classes = useStyles();
  return <div className={`${classes.list} ${stale ? classes.stale : ''}`} aria-busy={stale}>
    {findings.map(finding => <FindingRow key={finding.id} finding={finding} candidates={candidates} renderCandidateLink={renderCandidateLink} headingLevel={headingLevel} />)}
  </div>;
}

/** The questions Jev will answer, shown before any answer exists. */
export function PendingChecks({ titles, busy, headingLevel = 'h3' }: { titles: string[]; busy: boolean; headingLevel?: HeadingLevel }) {
  const classes = useStyles();
  return <div className={classes.list}>
    {titles.map((title, index) => <div key={`${title}:${index}`} className={classes.pending}>
      <Typography variant="subtitle2" component={headingLevel} color="textSecondary">{title}</Typography>
      {busy ? <Skeleton width="40%" /> : <Typography variant="caption" color="textSecondary">Not checked yet</Typography>}
    </div>)}
  </div>;
}
