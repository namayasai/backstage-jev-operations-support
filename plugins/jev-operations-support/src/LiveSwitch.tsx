import { useId } from 'react';
import { Box, FormControlLabel, Switch, Typography } from '@material-ui/core';

export interface LiveSwitchProps {
  live: boolean;
  onChange: (value: boolean) => void;
  /** `true` when a host prop forces automatic sends off for this view, regardless of the reader's preference. */
  forcedOff?: boolean;
  /** Applied to the outer wrapper, e.g. to match a `CardHeader`'s `action` spacing. */
  style?: React.CSSProperties;
}

/**
 * The Live toggle shared by every workflow view. When forced off, the reason used to live only
 * in a `title` attribute on the switch's wrapper span — unreachable by keyboard or screen
 * reader. It is now visible caption text next to the switch, linked to it with
 * `aria-describedby` so assistive tech reads the explanation together with the control.
 */
export function LiveSwitch({ live, onChange, forcedOff = false, style }: LiveSwitchProps) {
  const describedById = useId();
  return <Box display="flex" alignItems="center" flexWrap="wrap" style={{ gap: 8, ...style }}>
    {forcedOff && <Typography variant="caption" color="textSecondary" id={describedById}>Automatic checks are turned off for this view.</Typography>}
    <FormControlLabel style={{ margin: 0 }} labelPlacement="start" label={<Typography variant="body2">Live</Typography>}
      control={<Switch size="small" color="primary" checked={live} disabled={forcedOff} onChange={e => onChange(e.target.checked)}
        inputProps={{ 'aria-label': 'Live check', ...(forcedOff ? { 'aria-describedby': describedById } : {}) }} />} />
  </Box>;
}
