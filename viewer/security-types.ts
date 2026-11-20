/* Adapted from EA-PDF Generator (Copyright 2026 ThinkBox Digital), Apache-2.0. */
import type {Certificate} from 'pkijs';
export type SecurityState='PASS'|'FAIL'|'UNKNOWN'|'NOT_APPLICABLE';
export type SecurityCategory='C2PA'|'PAdES'|'C2PA + PAdES'|'CMS'|'Certificate trust'|'Other checks';
export type SecurityCheck={name:string;status:SecurityState;detail:string;category?:SecurityCategory};
export type PdfRangeHasher=(end:number,gaps:[number,number][])=>Promise<string>;
export type TrustSource='SESSION'|'BUILD'|'NONE';
export type PublicTimestampSource={name:string;url:string;sha256?:string;bundle?:boolean;bytes?:Uint8Array;backup?:Uint8Array;bundled?:boolean;error?:string};
export type TimestampAnchor={bytes:Uint8Array;source:string};
export type PdfSignatureFacts={contents:Uint8Array;byteRange:number[];type:string;subFilter:string};
export type SecurityEvidence={certificates:Uint8Array[];crls:Uint8Array[];ocsps:Uint8Array[];error?:string};
export type SecurityFacts={signatures:PdfSignatureFacts[];encrypted:boolean;evidence?:SecurityEvidence};
export type SecurityInput={blob:Blob;facts:SecurityFacts;files?:CredentialFiles;manifestDigest:string;instanceId?:string;expectedCredentials:boolean;expectedPades:boolean;expectedSignature:boolean;expectedTimestamp:boolean;manifestSigner?:{signer:Certificate;certificates:Certificate[]};discoveryError?:string;credentialError?:string};
export type CredentialFiles={credentials?:Uint8Array;credentialOffset?:number;policy?:Uint8Array};
export type SelectedTrustCertificate={sha256:string;subject:string;issuer:string;notBefore:string;notAfter:string};
export type SecurityReport={schemaVersion:1;status:SecurityState;trustStatus:SecurityState;trustSource:TrustSource;c2paSignerIdentity?:'LOCAL_EPHEMERAL_UNTRUSTED'|'CONFIGURED_CERTIFICATE';checks:SecurityCheck[];checkedAt:string;fileSize:number;elapsedMilliseconds?:number;pdfSignaturesChecked?:number;filename?:string;fileSha256?:string;scope:string;certificates:{sha256:string;subject:string;notBefore:string;notAfter:string}[];selectedCertificates?:SelectedTrustCertificate[]};

/** Bounded facts extracted independently from each saved creator revision. */
export type CreatorArchiveRevision={end:number;startXRef:number;previousXRef:number;protectedSha256:string;signatures:PdfSignatureFacts[];signatureRefs:string[];fieldNames:string[];credentials?:Uint8Array;credentialOffset?:number;policy?:Uint8Array;evidence:SecurityEvidence};
export type CreatorArchiveFacts={schemaVersion:1;status:'COMPLETE'|'INVALID'|'UNAVAILABLE';detail?:string;revisions?:CreatorArchiveRevision[]};
export type CreatorArchiveReader=(ends:number[],hasCredentials:boolean)=>Promise<CreatorArchiveFacts>;
