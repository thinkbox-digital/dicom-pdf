package digital.thinkbox.dicompdf;

import java.nio.file.*;
import org.dcm4che3.data.*;

/** Small, deterministic fixtures for the newly implemented 2026d subset. */
public final class SpecSyntheticFixtures {
    private SpecSyntheticFixtures() {}
    public static void main(String[] args)throws Exception {
        Path root=Path.of(args.length==0?"fixtures/spec-display":args[0]);Files.createDirectories(root);
        var padding=SpecDisplayTest.phantom(false,0,1,100,200);padding.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150101");
        padding.setInt(Tag.PixelPaddingValue,VR.US,0);padding.setInt(Tag.PixelPaddingRangeLimit,VR.US,1);
        Files.write(root.resolve("unsigned-padding-range.dcm"),SpecDisplayTest.encode(padding));
        var signed=SpecDisplayTest.phantom(true,-2048,-1025,10,20);signed.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150102");
        signed.setInt(Tag.PixelPaddingValue,VR.SS,-2048);signed.setInt(Tag.PixelPaddingRangeLimit,VR.SS,-1025);
        signed.setString(Tag.RescaleSlope,VR.DS,"-2");signed.setString(Tag.RescaleIntercept,VR.DS,"100");
        Files.write(root.resolve("signed-padding-negative-rescale.dcm"),SpecDisplayTest.encode(signed));
        var aspect=SpecDisplayTest.phantom(false,0,255,255,255);aspect.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150103");
        aspect.setString(Tag.PixelSpacing,VR.DS,"2","1");Files.write(root.resolve("non-square-pixel-spacing.dcm"),SpecDisplayTest.encode(aspect));
        aspect.remove(Tag.PixelSpacing);aspect.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150104");aspect.setString(Tag.PixelAspectRatio,VR.IS,"3","2");
        Files.write(root.resolve("non-square-pixel-aspect.dcm"),SpecDisplayTest.encode(aspect));
        var enhanced=SpecDisplayTest.phantom(false,10,20,30,40,100,200,300,400);
        enhanced.setString(Tag.SOPClassUID,VR.UI,UID.EnhancedMRImageStorage);enhanced.setString(Tag.SOPInstanceUID,VR.UI,"2.25.202611150105");
        enhanced.setString(Tag.Modality,VR.CS,"MR");enhanced.remove(Tag.ConversionType);enhanced.setInt(Tag.NumberOfFrames,VR.IS,2);
        enhanced.setString(Tag.ContentDate,VR.DA,"20261115");enhanced.setString(Tag.ContentTime,VR.TM,"000000");
        var shared=new Attributes();var measures=new Attributes();measures.setString(Tag.PixelSpacing,VR.DS,"2","1");
        measures.setString(Tag.SliceThickness,VR.DS,"1");shared.newSequence(Tag.PixelMeasuresSequence,1).add(measures);
        enhanced.newSequence(Tag.SharedFunctionalGroupsSequence,1).add(shared);var per=enhanced.newSequence(Tag.PerFrameFunctionalGroupsSequence,2);
        for(int frame=0;frame<2;frame++){
            var item=new Attributes();var transform=new Attributes();transform.setString(Tag.RescaleSlope,VR.DS,frame==0?"1":"2");
            transform.setString(Tag.RescaleIntercept,VR.DS,frame==0?"0":"-100");transform.setString(Tag.RescaleType,VR.LO,"US");item.newSequence(Tag.PixelValueTransformationSequence,1).add(transform);
            var voi=new Attributes();voi.setString(Tag.WindowCenter,VR.DS,frame==0?"25.5":"400.5");voi.setString(Tag.WindowWidth,VR.DS,frame==0?"31":"601");
            item.newSequence(Tag.FrameVOILUTSequence,1).add(voi);per.add(item);
        }
        Files.write(root.resolve("enhanced-exclusive-functional-groups.dcm"),SpecDisplayTest.encode(enhanced));
        System.out.println("Wrote five synthetic display fixtures to "+root);
    }
}
