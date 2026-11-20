const PREFIX='1.2.840.10008.1.2.4.';
export const JPEG_LS=new Set(['80','81'].map(suffix=>PREFIX+suffix));
export const JPEG2000=new Set(['90','91','201','202','203'].map(suffix=>PREFIX+suffix));
