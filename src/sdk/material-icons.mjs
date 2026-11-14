// SDK 7.29.0 only consumes these two names from the w700 barrel.
// Preserve its original components via public leaf exports, without loading
// the full icon catalogue into Vite's optimizer. No wallet code is replaced.
export { ArrowDownwardW700 as ArrowDownward } from '@material-symbols-svg/react-rounded/icons/arrow-downward';
export { OpenInNewW700 as OpenInNew } from '@material-symbols-svg/react-rounded/icons/open-in-new';
