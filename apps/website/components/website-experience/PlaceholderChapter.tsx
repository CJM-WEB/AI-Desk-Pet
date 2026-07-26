import styles from './website-experience.module.css';

interface PlaceholderChapterProps {
  title: string;
}

export function PlaceholderChapter({ title }: PlaceholderChapterProps) {
  return (
    <div className={styles.placeholderContent}>
      <h2>{title}</h2>
      <p>内容准备中</p>
    </div>
  );
}
