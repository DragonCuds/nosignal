import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const Icon = ({ children, ...props }: IconProps) => (
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    {children}
  </svg>
);

export const SearchIcon = (props: IconProps) => <Icon {...props}><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 4 4"/></Icon>;
export const ComposeIcon = (props: IconProps) => <Icon {...props}><path d="M13.7 5.1 18.9 10.3 9.2 20H4v-5.2z"/><path d="m15.5 3.3 5.2 5.2"/></Icon>;
export const SunIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></Icon>;
export const MoonIcon = (props: IconProps) => <Icon {...props}><path d="M20.2 15.2A8.7 8.7 0 0 1 8.8 3.8 8.7 8.7 0 1 0 20.2 15.2Z"/></Icon>;
export const LogoutIcon = (props: IconProps) => <Icon {...props}><path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10"/></Icon>;
export const CloseIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>;
export const ChevronIcon = (props: IconProps) => <Icon {...props}><path d="m9 5 7 7-7 7"/></Icon>;
export const ChatIcon = (props: IconProps) => <Icon {...props}><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.7 8.7 0 0 1-3.1-.6L4 20l1.7-4.3A7.9 7.9 0 1 1 20 11.5Z"/><path d="M8.5 10.5h7M8.5 14h4.5"/></Icon>;
export const CheckIcon = (props: IconProps) => <Icon {...props}><path d="m5 12 4 4L19 6"/></Icon>;
export const DoubleCheckIcon = (props: IconProps) => <Icon {...props}><path d="m2.8 12 4 4L16.8 6"/><path d="m10.2 14.8 1.2 1.2L21.2 6"/></Icon>;
export const ClockIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></Icon>;
export const BackIcon = (props: IconProps) => <Icon {...props}><path d="m15 5-7 7 7 7"/></Icon>;
export const SmileIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01M8.5 14.5c2.2 2 4.8 2 7 0"/></Icon>;
export const AttachIcon = (props: IconProps) => <Icon {...props}><path d="m8.5 12.5 5.7-5.7a3.5 3.5 0 0 1 5 5L11 20a5.2 5.2 0 0 1-7.4-7.4l8.3-8.3a2.7 2.7 0 0 1 3.8 3.8l-7.6 7.6a1.4 1.4 0 0 1-2-2l6.8-6.8"/></Icon>;
export const SendIcon = (props: IconProps) => <Icon {...props}><path d="m21 3-7.7 18-2.1-8.2L3 9.7Z"/><path d="m11.2 12.8 4.5-4.5"/></Icon>;
export const MicIcon = (props: IconProps) => <Icon {...props}><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></Icon>;
export const DownIcon = (props: IconProps) => <Icon {...props}><path d="m5 9 7 7 7-7"/></Icon>;
export const RetryIcon = (props: IconProps) => <Icon {...props}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M18.2 9a7 7 0 0 0-11.8-2.5L4 9M5.8 15a7 7 0 0 0 11.8 2.5L20 15"/></Icon>;
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></Icon>;
export const StickerIcon = (props: IconProps) => <Icon {...props}><path d="M5 3h9a5 5 0 0 1 5 5v6l-7 7H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M12 21v-5a2 2 0 0 1 2-2h5M8 9h.01M14 9h.01M8 12.5c2 1.6 4 1.6 6 0"/></Icon>;
export const GifIcon = (props: IconProps) => <Icon {...props}><rect x="2.5" y="5" width="19" height="14" rx="3"/><path d="M8.5 10a2.5 2.5 0 1 0 0 4H10v-2H8.5M13 10v4M16 14v-4h3"/></Icon>;
export const RecentIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="8"/><path d="M12 7v5l-3 2"/></Icon>;
export const UploadIcon = (props: IconProps) => <Icon {...props}><path d="M12 16V4M7 9l5-5 5 5M4 15v4h16v-4"/></Icon>;
export const MenuIcon = (props: IconProps) => <Icon {...props}><path d="M4 7h16M4 12h16M4 17h16"/></Icon>;
export const MoreIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="5.5" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="18.5" r="1.1" fill="currentColor"/></Icon>;
export const ReplyIcon = (props: IconProps) => <Icon {...props}><path d="M9.5 5 4 10.5 9.5 16"/><path d="M4 10.5h9a7 7 0 0 1 7 7V19"/></Icon>;
export const CopyIcon = (props: IconProps) => <Icon {...props}><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></Icon>;
export const EditIcon = (props: IconProps) => <Icon {...props}><path d="m4 20 1-4.2L16.2 4.6a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19Z"/><path d="m14.5 6.3 3.2 3.2"/></Icon>;
export const TrashIcon = (props: IconProps) => <Icon {...props}><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7M10 11v6M14 11v6"/></Icon>;
export const StarIcon = (props: IconProps) => <Icon {...props}><path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8Z"/></Icon>;
export const LockIcon = (props: IconProps) => <Icon {...props}><rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></Icon>;
export const UpIcon = (props: IconProps) => <Icon {...props}><path d="m5 15 7-7 7 7"/></Icon>;
export const UserIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></Icon>;
export const ShieldIcon = (props: IconProps) => <Icon {...props}><path d="M12 3.2 5 6v5.5c0 4.3 2.8 7.6 7 9.3 4.2-1.7 7-5 7-9.3V6Z"/><path d="m9 12 2.2 2.2L15.2 10"/></Icon>;
export const ImageIcon = (props: IconProps) => <Icon {...props}><rect x="3.5" y="4.5" width="17" height="15" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="m4 17 5-4.5 3.5 3L15 13.5l5 4.5"/></Icon>;
