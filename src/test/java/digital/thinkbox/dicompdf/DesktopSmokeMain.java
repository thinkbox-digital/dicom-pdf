package digital.thinkbox.dicompdf;

import digital.thinkbox.pdfsecurity.testing.SecurityFixtures;

import java.awt.*;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.util.concurrent.Callable;
import javax.imageio.ImageIO;
import javax.swing.*;

/** Opt-in visible-desktop smoke test; mathematical fixtures only. Not a Surefire test. */
public final class DesktopSmokeMain {
    public static void main(String[] args)throws Exception{
        Path run=Path.of(args[0]).toAbsolutePath(),pdf=Path.of(args[1]).toAbsolutePath();
        Files.createDirectories(run);Path inputs=run.resolve("inputs");SyntheticFixtures.writeSupported(inputs);
        String requested=args.length>2?args[2]:"directory";String mode=requested.equals("retry")?"overwrite":requested;Path selected=inputs;int count=25;
        if(mode.equals("single")){selected=InputFiles.collect(inputs).getFirst();count=1;}
        else if(mode.equals("zip")||mode.equals("retry")||mode.equals("overwrite")){
            selected=run.resolve("study.zip");count=25;
            try(var zip=new java.util.zip.ZipOutputStream(Files.newOutputStream(selected))){
                for(Path file:InputFiles.collect(inputs)){zip.putNextEntry(new java.util.zip.ZipEntry(inputs.relativize(file).toString()));Files.copy(file,zip);zip.closeEntry();}
            }
        }
        final Path source=selected;byte[] original=Files.isRegularFile(source)?Files.readAllBytes(source):null;
        boolean passphraseMode=mode.equals("passphrase"),signed=mode.equals("signed")||passphraseMode;
        Path certificate=signed?SecurityFixtures.institution(run.resolve("credentials"),false,true).pkcs12():null;
        Path passphraseFile=passphraseMode?Files.writeString(run.resolve("password.txt"),new String(SecurityFixtures.PASSWORD)):null;
        byte[] previousPdf=null;
        if(mode.equals("overwrite")){DicomPdf.create(inputs,pdf);previousPdf=Files.readAllBytes(pdf);}
        JFrame frame=null;
        var uiErrors=new java.util.concurrent.CopyOnWriteArrayList<Throwable>();var oldHandler=Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread,error)->{uiErrors.add(error);error.printStackTrace(System.err);});
        try{
            ArchiveDesktop.launch("create");
            frame=awaitFrame();JFrame window=frame;
            if(mode.equals("overwrite")){
                edt(()->{((JTextField)find(window,"Source input")).setText(source.toString());((JTextField)find(window,"Output PDF")).setText(pdf.toString());return null;});
                overwriteClick(window,false);awaitIdle(window);
                if(!java.util.Arrays.equals(previousPdf,Files.readAllBytes(pdf)))throw new AssertionError("Cancel changed the existing PDF");
                if(!edt(()->((JLabel)find(window,"Run summary")).getText()).contains("cancelled"))throw new AssertionError("Overwrite cancel was not reported");
                Path corrupt=Files.writeString(run.resolve("corrupt.zip"),"synthetic invalid ZIP");
                edt(()->{((JTextField)find(window,"Source input")).setText(corrupt.toString());return null;});
                overwriteClick(window,true);awaitIdle(window);
                if(!edt(()->((JLabel)find(window,"Operation status")).getText()).equals("Failed"))throw new AssertionError("Invalid replacement did not fail");
                if(!java.util.Arrays.equals(previousPdf,Files.readAllBytes(pdf)))throw new AssertionError("Failed conversion changed the existing PDF");
                screenshot(window,run.resolve("failed-replacement.png"));
            }
            edt(()->{
                ((JTextField)find(window,"Source input")).setText(source.toString());
                ((JTextField)find(window,"Output PDF")).setText(pdf.toString());
                if(signed)((JTextField)find(window,"Signing identity")).setText(certificate.toString());
                if(passphraseMode)((JTextField)find(window,"Signing passphrase file")).setText(passphraseFile.toString());
                boolean[] cancel={signed};Timer prompt=new Timer(100,null);prompt.addActionListener(e->{
                    for(Window dialog:Window.getWindows())if(dialog.isVisible()&&dialog instanceof JDialog){
                        Component confirmation=find((Container)dialog,"PDF replacement confirmation");
                        if(confirmation!=null&&mode.equals("overwrite")){prompt.stop();((JOptionPane)SwingUtilities.getAncestorOfClass(JOptionPane.class,confirmation)).setValue("Replace");return;}
                        Component field=find((Container)dialog,"Signing certificate password");if(field instanceof JPasswordField password){
                            password.setText(new String(SecurityFixtures.PASSWORD));prompt.stop();((JOptionPane)SwingUtilities.getAncestorOfClass(JOptionPane.class,password)).setValue(cancel[0]?JOptionPane.CANCEL_OPTION:JOptionPane.OK_OPTION);return;
                        }
                    }
                });if(signed||mode.equals("overwrite"))prompt.start();((JButton)find(window,"Create archive")).doClick();prompt.stop();
                if(signed&&!passphraseMode){if(Files.exists(pdf)||!((JButton)find(window,"Create archive")).isEnabled())throw new AssertionError("Password cancel started an operation");cancel[0]=false;prompt.start();((JButton)find(window,"Create archive")).doClick();prompt.stop();}
                return null;
            });
            awaitIdle(window);
            String creation=edt(()->((JLabel)find(window,"Operation status")).getText());
            if(!creation.equals("Completed")||!Files.isRegularFile(pdf))throw new AssertionError("Creation failed: "+log(window));
            if(mode.equals("overwrite")&&java.util.Arrays.equals(previousPdf,Files.readAllBytes(pdf)))throw new AssertionError("Confirmed replacement did not publish the new PDF");
            if(edt(()->find(window,"Verification checks"))!=null)throw new AssertionError("Validation table shown during creation");
            int expected=count;
            if(!edt(()->((JLabel)find(window,"Run summary")).getText()).contains(expected+" supplied files"))throw new AssertionError("Wrong supplied inventory count");
            screenshot(window,run.resolve("creator.png"));
            edt(()->{
                ((JTabbedPane)find(window,"Operation")).setSelectedIndex(1);
                ((JTextField)find(window,"Archive PDF")).setText(pdf.toString());
                ((JTextField)find(window,"Original source input")).setText(source.toString());
                ((JButton)find(window,"Validate archive")).doClick();return null;
            });
            awaitIdle(window);
            String validation=edt(()->((JLabel)find(window,"Operation status")).getText());
            if(!validation.equals(signed?"Review needed":"Completed"))throw new AssertionError("Validation failed: "+log(window));
            String result=edt(()->{
                JTable table=(JTable)find(window,"Verification checks");StringBuilder values=new StringBuilder();
                for(int row=0;row<table.getRowCount();row++)values.append(table.getValueAt(row,0)).append(": ").append(table.getValueAt(row,1)).append('\n');
                if(table.getRowCount()<5||!((JButton)find(window,"Save report…")).isEnabled())throw new AssertionError("Missing structured results or report export");
                if(signed&&(!values.toString().contains("manifest.cryptographicSignature: PASS")||!values.toString().contains("manifest.certificateTrust: UNKNOWN")))throw new AssertionError("Signing/trust results are not separate");
                return values.toString();
            });
            Files.writeString(run.resolve("checks.txt"),result);Files.writeString(run.resolve("details.txt"),log(window));screenshot(window,run.resolve("validator.png"));
            Path saved=run.resolve("saved-report.json");
            edt(()->{
                Timer timer=new Timer(100,null);timer.addActionListener(e->{
                    for(Window dialog:Window.getWindows())if(dialog.isVisible()&&dialog instanceof JDialog){
                        JFileChooser chooser=chooser(dialog);if(chooser!=null){timer.stop();chooser.setSelectedFile(saved.toFile());chooser.approveSelection();return;}
                    }
                });timer.start();((JButton)find(window,"Save report…")).doClick();timer.stop();return null;
            });
            if(!Files.isRegularFile(saved)||!Files.readString(saved).contains(signed?"originalBytes":"sourceBytes"))throw new AssertionError("JSON report was not saved");
            for(int width:new int[]{740,1456}){
                edt(()->{window.setSize(width,Math.min(window.getHeight(),900));window.validate();return null;});Thread.sleep(100);
                edt(()->{checkScrollbars(window);return null;});
            }
            if(original!=null&&!java.util.Arrays.equals(original,Files.readAllBytes(source)))throw new AssertionError("Selected source changed");
            if(!uiErrors.isEmpty())throw new AssertionError("Uncaught desktop exception",uiErrors.getFirst());
            System.out.println("PASS: visible Swing creator and validator, "+mode+", "+count+" embedded synthetic originals, veraPDF, source comparison, result table and actual JSON report export.\n"+result);
        }finally{Thread.setDefaultUncaughtExceptionHandler(oldHandler);if(frame!=null){JFrame window=frame;edt(()->{window.dispose();return null;});}}
    }
    private static JFrame awaitFrame()throws Exception{
        for(int attempt=0;attempt<100;attempt++){
            JFrame frame=edt(()->{for(Frame candidate:Frame.getFrames())if(candidate instanceof JFrame value&&value.isVisible()&&value.getTitle().startsWith("Archival DICOM"))return value;return null;});
            if(frame!=null)return frame;Thread.sleep(100);
        }throw new AssertionError("Desktop window did not open");
    }
    private static void overwriteClick(JFrame window,boolean accept)throws Exception{
        edt(()->{
            Timer prompt=new Timer(100,null);prompt.addActionListener(e->{
                for(Window dialog:Window.getWindows())if(dialog.isVisible()&&dialog instanceof JDialog){
                    Component confirmation=find((Container)dialog,"PDF replacement confirmation");
                    if(confirmation!=null){prompt.stop();((JOptionPane)SwingUtilities.getAncestorOfClass(JOptionPane.class,confirmation)).setValue(accept?"Replace":"Cancel");return;}
                }
            });prompt.start();((JButton)find(window,"Create archive")).doClick();prompt.stop();return null;
        });
    }
    private static void awaitIdle(JFrame frame)throws Exception{
        for(int attempt=0;attempt<1200;attempt++){
            if(edt(()->((JButton)find(frame,"Create archive")).isEnabled()))return;
            Thread.sleep(100);
        }throw new AssertionError("Desktop operation timed out");
    }
    private static String log(JFrame frame)throws Exception{return edt(()->((JTextArea)find(frame,"Operation details")).getText());}
    private static Component find(Container parent,String name){
        if(parent instanceof JComponent item&&(!(item instanceof JLabel)||java.util.List.of("Operation status","Run summary").contains(name))&&name.equals(item.getAccessibleContext().getAccessibleName()))return item;
        for(Component child:parent.getComponents())if(child instanceof Container container){Component found=find(container,name);if(found!=null)return found;}
        return null;
    }
    private static JFileChooser chooser(Container parent){
        if(parent instanceof JFileChooser value)return value;
        for(Component child:parent.getComponents())if(child instanceof Container container){JFileChooser found=chooser(container);if(found!=null)return found;}
        return null;
    }
    private static void checkScrollbars(Container parent){
        for(Component child:parent.getComponents()){
            if(child instanceof JScrollPane scroll&&(scroll.getHorizontalScrollBarPolicy()!=JScrollPane.HORIZONTAL_SCROLLBAR_NEVER||scroll.getHorizontalScrollBar().isVisible()))throw new AssertionError("Horizontal scrollbar in desktop");
            if(child instanceof Container container)checkScrollbars(container);
        }
    }
    private static <T>T edt(Callable<T> work)throws Exception{
        var result=new java.util.concurrent.FutureTask<T>(work);SwingUtilities.invokeAndWait(result);return result.get();
    }
    private static void screenshot(JFrame frame,Path destination)throws Exception{
        edt(()->{BufferedImage image=new BufferedImage(frame.getWidth(),frame.getHeight(),BufferedImage.TYPE_INT_RGB);Graphics2D graphics=image.createGraphics();try{frame.paint(graphics);}finally{graphics.dispose();}ImageIO.write(image,"png",destination.toFile());return null;});
    }
}
