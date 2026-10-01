/** MaterialFileIcon：文件名优先于 MIME、复合后缀、装饰图片边界。 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaterialFileIcon } from './material-file-icon';

describe('MaterialFileIcon', () => {
  it.each([
    ['README.MD', 'text/plain', 'readme'],
    ['report.MD', 'application/octet-stream', 'markdown'],
    ['analysis.PY', 'text/plain', 'python'],
    ['model.R', undefined, 'r'],
    ['schema.d.ts', 'text/plain', 'typescript-def'],
    ['schema.d.mts', undefined, 'typescript-def'],
    ['component.tsx', undefined, 'react'],
    ['results.csv', 'text/plain', 'table'],
    ['events.jsonl', undefined, 'json'],
    ['archive.tar.gz', undefined, 'zip'],
    ['.gitignore', undefined, 'git'],
    ['Dockerfile', undefined, 'docker'],
    ['scan', 'Image/TIFF; charset=binary', 'image'],
    ['download', 'application/pdf', 'pdf'],
    ['unknown.custom', 'application/octet-stream', 'file'],
    ['unknown.custom', null, 'file'],
    ['json', undefined, 'file'],
    ['report.pdf.exe', undefined, 'file'],
    ['folder.with.dots/README', undefined, 'readme'],
    ['C:\\reports\\result.PDF', undefined, 'pdf'],
    ['__proto__', undefined, 'file'],
  ])('classifies %s using filename before MIME', (name, mimeType, icon) => {
    expect(
      renderToStaticMarkup(
        <MaterialFileIcon name={name} mimeType={mimeType} />,
      ),
    ).toContain(`data-material-file-icon="${icon}"`);
  });

  it('uses a folder icon even when the directory looks like a filename', () => {
    expect(
      renderToStaticMarkup(
        <MaterialFileIcon
          name="results.csv"
          kind="folder"
          mimeType="text/csv"
        />,
      ),
    ).toContain('data-material-file-icon="folder"');
  });

  it('keeps file names out of image URLs and accessible labels', () => {
    const markup = renderToStaticMarkup(
      <MaterialFileIcon name="private-research.unknown" />,
    );
    expect(markup).toContain('alt=""');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('width="20"');
    expect(markup).toContain('height="20"');
    expect(markup).not.toContain('private-research');
  });
});
