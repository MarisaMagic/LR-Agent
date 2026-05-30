import { VscodeToolbarButton } from '@vscode-elements/react-elements';
import { useEffect, useRef, type ComponentRef } from 'react';

interface VscodeClickableToolbarButtonProps {
  icon: string;
  label: string;
  onClick: () => void;
}

/** VscodeToolbarButton 需通过原生 click 监听，React onClick 在 WC 上不可靠 */
export default function VscodeClickableToolbarButton({
  icon,
  label,
  onClick,
}: VscodeClickableToolbarButtonProps) {
  const ref = useRef<ComponentRef<typeof VscodeToolbarButton>>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const handler = () => onClick();
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [onClick]);

  return <VscodeToolbarButton ref={ref} icon={icon} label={label} />;
}
