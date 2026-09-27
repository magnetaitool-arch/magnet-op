(function (root) {
  'use strict';
  const M = root.MagnetBuilderModel;
  const size = (d) => (d.pageSize === 'portrait' ? [794, 1123] : [1280, 720]);
  async function render(d, page, { scale = 1, assets = {} } = {}) {
    M.validate(d);
    await Promise.all([
      document.fonts.load('20px "' + d.brand.font + '"'),
      document.fonts.load('20px "Readex Pro"', '\u0627\u0644\u0639\u0631\u0628\u064a\u0629'),
    ]);
    await document.fonts.ready;
    const [w, h] = size(d),
      canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const c = canvas.getContext('2d');
    c.scale(scale, scale);
    c.fillStyle = d.brand.secondary;
    c.fillRect(0, 0, w, h);
    c.fillStyle = d.brand.primary;
    c.direction = d.language === 'ar' ? 'rtl' : 'ltr';
    const font = d.language === 'ar' ? 'Readex Pro' : d.brand.font,
      errors = [];
    let y = 48;
    function text(
      value,
      x,
      top,
      width,
      fontSize = 20,
      color = d.brand.primary,
      align = 'left',
      maxLines = 99,
    ) {
      c.font = `${fontSize}px "${font}","Readex Pro",Arial`;
      c.fillStyle = color;
      c.textAlign = align;
      const words = String(value).split(/\s+/),
        lines = [];
      let line = '';
      for (const word of words) {
        if (c.measureText(word).width > width) {
          if (line) {
            lines.push(line);
            line = '';
          }
          let part = '';
          for (const ch of word) {
            if (c.measureText(part + ch).width > width) {
              lines.push(part);
              part = '';
            }
            part += ch;
          }
          line = part;
          continue;
        }
        const next = line ? line + ' ' + word : word;
        if (c.measureText(next).width > width && line) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      if (line) lines.push(line);
      const lineHeight = fontSize * 1.5;
      if (lines.length > maxLines)
        errors.push(
          d.language === 'ar' ? 'النص يتجاوز مساحة البلوك' : 'Text exceeds the block height',
        );
      lines
        .slice(0, maxLines)
        .forEach((v, i) =>
          c.fillText(
            v,
            align === 'right' ? x + width : align === 'center' ? x + width / 2 : x,
            top + fontSize + i * lineHeight,
          ),
        );
      return lines.length * lineHeight;
    }
    for (const b of page.blocks) {
      if (y + b.height > h - 40) {
        errors.push(
          d.language === 'ar'
            ? 'الصفحة ممتلئة؛ انقل بلوكًا إلى صفحة أخرى'
            : 'Page overflow; move a block to another page',
        );
        break;
      }
      if (b.type === 'spacer') {
        y += b.height;
        continue;
      }
      const x = 48,
        bw = w - 96,
        accent = b.variant === 'accent' || b.type === 'cover';
      if (accent) {
        c.fillStyle = d.brand.primary;
        c.fillRect(x - 12, y - 8, bw + 24, b.height);
      }
      if (b.type === 'cover' && b.mediaId) {
        try {
          if (!assets[b.mediaId]) throw Error();
          const logo = new Image();
          logo.crossOrigin = 'anonymous';
          logo.src = assets[b.mediaId];
          await logo.decode();
          const ratio = Math.min(120 / logo.width, 100 / logo.height);
          c.drawImage(logo, x + bw - 128, y + 20, logo.width * ratio, logo.height * ratio);
        } catch {
          errors.push(
            d.language === 'ar'
              ? '\u062a\u0639\u0630\u0631 \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0634\u0639\u0627\u0631'
              : 'Brand logo is unavailable; retry before export',
          );
        }
      }
      if (!accent && b.variant === 'minimal') {
        c.strokeStyle = d.brand.accent;
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(x, y + b.height - 6);
        c.lineTo(x + bw, y + b.height - 6);
        c.stroke();
      }
      const ink = accent ? d.brand.secondary : d.brand.primary;
      let cursor = y + 8;
      const titleSize = b.type === 'cover' ? 42 : b.type === 'headline' ? 32 : 23;
      cursor +=
        text(
          b.title,
          x,
          cursor,
          b.type === 'cover' && b.mediaId ? bw - 160 : bw,
          titleSize,
          accent ? d.brand.accent : ink,
          b.alignment,
          Math.max(0, Math.floor((b.height - 20) / (titleSize * 1.5))),
        ) + 12;
      if (cursor > y + b.height - 8)
        errors.push(
          d.language === 'ar'
            ? '\u0627\u0644\u0645\u062d\u062a\u0648\u0649 \u064a\u062a\u062c\u0627\u0648\u0632 \u0627\u0631\u062a\u0641\u0627\u0639 \u0627\u0644\u0628\u0644\u0648\u0643'
            : 'Content exceeds block height',
        );
      if (b.type === 'image' || b.type === 'logo') {
        const src = assets[b.mediaId];
        if (src) {
          try {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = src;
            await img.decode();
            const maxH = Math.max(20, y + b.height - cursor - 12),
              ratio = Math.min(bw / img.width, maxH / img.height);
            c.drawImage(
              img,
              x + (bw - img.width * ratio) / 2,
              cursor,
              img.width * ratio,
              img.height * ratio,
            );
          } catch {
            errors.push('Image could not be loaded');
          }
        } else {
          if (b.mediaId) errors.push('Image is unavailable; retry before export');
          text(
            d.language === 'ar'
              ? 'اختر ملف صورة مرتبطًا بالمهمة'
              : 'Select an image linked to this task',
            x,
            cursor,
            bw,
            18,
            ink,
            b.alignment,
          );
        }
      } else if (b.type === 'chart' && b.rows.length) {
        const rows = b.rows.filter((r) => r[0] && r[1] !== '' && Number.isFinite(Number(r[1]))),
          max = Math.max(1, ...rows.map((r) => Math.abs(Number(r[1])))),
          negative = rows.some((r) => Number(r[1]) < 0),
          positive = rows.some((r) => Number(r[1]) > 0),
          plotWidth = bw * 0.42,
          zero = x + bw * 0.38 + (negative ? (positive ? plotWidth / 2 : plotWidth) : 0);
        let barY = cursor;
        for (const r of rows) {
          if (barY + 32 > y + b.height) {
            errors.push('Chart exceeds block height');
            break;
          }
          text(r[0], x, barY, bw * 0.35, 16, ink, b.alignment, 1);
          c.fillStyle = d.brand.accent;
          const length =
            (plotWidth * Math.abs(Number(r[1]))) / max / (negative && positive ? 2 : 1);
          c.fillRect(Number(r[1]) < 0 ? zero - length : zero, barY + 4, length, 20);
          c.strokeStyle = ink;
          c.beginPath();
          c.moveTo(zero, barY);
          c.lineTo(zero, barY + 28);
          c.stroke();
          text(r[1], x + bw * 0.82, barY, bw * 0.18, 16, ink, 'right', 1);
          barY += 34;
        }
      } else if (b.rows.length) {
        const cols = Math.max(...b.rows.map((r) => r.length)),
          cw = bw / cols;
        for (const row of b.rows) {
          let rh = 32;
          for (let i = 0; i < cols; i++) {
            const cell = String(row[i] || '');
            c.font = `17px "${font}","Readex Pro",Arial`;
            rh = Math.max(rh, Math.ceil(c.measureText(cell).width / (cw - 16)) * 26 + 10);
          }
          if (cursor + rh > y + b.height - 5) {
            errors.push(
              d.language === 'ar' ? 'صفوف الجدول تتجاوز البلوك' : 'Rows exceed block height',
            );
            break;
          }
          row.forEach((value, i) => {
            const col = d.language === 'ar' ? cols - 1 - i : i;
            text(
              value,
              x + col * cw + 8,
              cursor,
              cw - 16,
              17,
              ink,
              b.alignment,
              Math.floor(rh / 25),
            );
          });
          c.strokeStyle = d.brand.accent;
          c.beginPath();
          c.moveTo(x, cursor + rh);
          c.lineTo(x + bw, cursor + rh);
          c.stroke();
          cursor += rh;
        }
      } else if (b.text) {
        text(
          b.text,
          x,
          cursor,
          b.type === 'cover' && b.mediaId ? bw - 160 : bw,
          b.type === 'big_number' ? 52 : 20,
          ink,
          b.alignment,
          Math.max(
            0,
            Math.floor((y + b.height - cursor - 8) / (b.type === 'big_number' ? 78 : 30)),
          ),
        );
      } else if (b.type !== 'headline')
        text(
          d.language === 'ar'
            ? 'أضف المحتوى أو اربط بيانات فعلية'
            : 'Add content or bind available real data',
          x,
          cursor,
          bw,
          17,
          ink,
          b.alignment,
          2,
        );
      y += b.height + 16;
    }
    c.font = `13px "${font}","Readex Pro",Arial`;
    c.fillStyle = d.brand.primary;
    c.textAlign = 'left';
    c.direction = 'ltr';
    c.fillText('MAGNET / \u2068' + d.title.slice(0, 65) + '\u2069', 48, h - 16);
    c.textAlign = 'right';
    c.fillText(
      d.language === 'ar'
        ? new Intl.NumberFormat('ar-EG').format(d.pages.findIndex((p) => p.id === page.id) + 1) +
            ' \u0645\u0646 ' +
            new Intl.NumberFormat('ar-EG').format(d.pages.length)
        : String(d.pages.findIndex((p) => p.id === page.id) + 1) + ' / ' + d.pages.length,
      w - 48,
      h - 16,
    );
    return { canvas, errors: [...new Set(errors)] };
  }
  root.MagnetBuilderRender = { render, size };
})(window);
