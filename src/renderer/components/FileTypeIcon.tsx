import { getSetiFileIconSvg, getSetiFolderIconSvg } from '../utils/seti-icons';

interface FileTypeIconProps {
  path: string;
  isFolder?: boolean;
  isOpen?: boolean;
  size?: number;
  className?: string;
  slot?: string;
}

export default function FileTypeIcon({
  path,
  isFolder,
  isOpen,
  size,
  className,
  slot,
}: FileTypeIconProps) {
  const svgMarkup = isFolder
    ? getSetiFolderIconSvg(Boolean(isOpen))
    : getSetiFileIconSvg(path);

  const isTreeIcon = Boolean(slot);
  const classes = [
    'file-type-icon',
    isTreeIcon ? 'file-tree-icon' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      slot={slot}
      className={classes}
      style={
        isTreeIcon || size === undefined
          ? undefined
          : { width: size, height: size }
      }
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: svgMarkup }}
    />
  );
}

FileTypeIcon.defaultProps = {
  isFolder: false,
  isOpen: false,
  size: 22,
  className: '',
  slot: undefined,
};
